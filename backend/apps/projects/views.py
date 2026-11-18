from datetime import timedelta

from django.db import IntegrityError, transaction
from django.db.models import Count, IntegerField, OuterRef, Prefetch, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import exceptions, mixins, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.billing.limits import check_can_add_project
from apps.core.api import TenantModelViewSet, WorkspaceScopedMixin
from apps.issues.activity import field_changes, record_event
from apps.issues.models import AuditLog, Issue
from apps.tenants.models import Membership, Workspace

from .models import RESERVED_STATUS_PREFIX, Board, Project, Sprint, WorkflowStatus, WorkflowTransition
from .serializers import (
    BoardSerializer, DeleteProjectSerializer, ProjectSerializer, SprintCompleteSerializer, SprintSerializer, SprintStartSerializer,
    WorkflowConfigSerializer, WorkflowStatusSerializer,
)
from .services import (
    assert_project_writable, assert_sprint_deletable, create_project, lock_project, prune_wip_limits,
)

Role = Membership.Role
DONE = WorkflowStatus.Category.DONE


@extend_schema_view(update=extend_schema(exclude=True))  # PUT /projects/{key}/ is gone; use PATCH
class ProjectViewSet(TenantModelViewSet):
    serializer_class = ProjectSerializer
    queryset = Project.objects.all()
    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z][A-Za-z0-9]{1,9}"
    # Deleting a project destroys its issues, files and sprints, so only the owner may do it.
    required_roles = {"create": Role.ADMIN, "update": Role.ADMIN, "partial_update": Role.ADMIN,
                      "destroy": Role.OWNER, "workflow": Role.VIEWER, "put": Role.ADMIN}

    def get_object(self):
        # Keys are stored uppercase; /projects/web/ and /projects/WEB/ are the same project.
        self.kwargs[self.lookup_field] = self.kwargs[self.lookup_field].upper()
        return super().get_object()

    def update(self, request, *args, **kwargs):
        if not kwargs.get("partial"):
            raise exceptions.MethodNotAllowed("PUT", detail="Use PATCH to update a project.")
        return super().update(request, *args, **kwargs)
    search_fields = ["name", "key"]
    filterset_fields = ["is_archived"]

    def get_queryset(self):
        return (
            super().get_queryset()
            .select_related("lead", "workflow")
            .prefetch_related(
                "workflow__statuses",
                "boards",
                Prefetch("sprints", queryset=Sprint.objects.filter(state=Sprint.State.ACTIVE), to_attr="active_sprints"),
            )
        )

    @staticmethod
    def with_counts(queryset):
        """Issue totals per project as correlated subqueries: cost grows with the projects shown, not with
        every issue in the workspace (JOIN + COUNT(DISTINCT) took 98 ms vs 33 ms at 100k issues)."""
        issues = Issue.objects.filter(project=OuterRef("pk")).order_by().values("project")
        count = lambda qs: Coalesce(Subquery(qs.annotate(n=Count("pk")).values("n"), output_field=IntegerField()), 0)
        return queryset.annotate(issue_count=count(issues), done_count=count(issues.filter(status__category=DONE)))

    def filter_queryset(self, queryset):
        queryset = super().filter_queryset(queryset)
        # Only the responses that show the counts pay for them (PATCH/DELETE/workflow lookups don't).
        return self.with_counts(queryset) if self.action in ("list", "retrieve") else queryset

    def _lock_workspace(self):
        # Serializes project creation and restores in this workspace, so the plan limit holds.
        Workspace.objects.select_for_update(no_key=True).filter(pk=self.workspace.pk).first()

    def perform_create(self, serializer):
        data = serializer.validated_data
        try:
            with transaction.atomic():
                self._lock_workspace()
                check_can_add_project(self.workspace)
                project = create_project(
                    workspace=self.workspace, created_by=self.request.user,
                    name=data["name"], key=data["key"], description=data.get("description", ""),
                    color=data.get("color", "#6366f1"), lead=data.get("lead"), board_type=data.get("board_type"),
                )
        except IntegrityError:  # unique (workspace, key) is the final safeguard
            raise exceptions.ValidationError({"key": ["This key is already used by another project."]})
        serializer.instance = self.with_counts(self.get_queryset()).get(pk=project.pk)
        record_event(self.workspace, self.request.user, AuditLog.Action.CREATED, AuditLog.Entity.PROJECT,
                     project.name, project=project)

    def perform_update(self, serializer):
        serializer.validated_data.pop("board_type", None)
        tracked = ("name", "description", "color", "lead_id", "is_archived")
        with transaction.atomic():
            if serializer.validated_data.get("is_archived") is False:
                self._lock_workspace()  # a restore counts toward the plan limit; workspace before project
            # Lock and RE-READ the row: the instance loaded for validation may be stale (e.g. issue_counter
            # moved on since), and the archive/restore rules must see the current state.
            serializer.instance = lock_project(serializer.instance.pk)
            restoring = serializer.instance.is_archived and serializer.validated_data.get("is_archived") is False
            if restoring:
                check_can_add_project(self.workspace)
            else:
                assert_project_writable(serializer.instance)  # archived: only the restore itself is allowed
            before = {field: getattr(serializer.instance, field) for field in tracked}
            project = serializer.save()  # writes only the changed columns (ProjectSerializer.update)
        changes = field_changes(project, before, tracked)
        if changes:
            action = AuditLog.Action.UPDATED
            if "is_archived" in changes:
                action = AuditLog.Action.ARCHIVED if project.is_archived else AuditLog.Action.RESTORED
            record_event(self.workspace, self.request.user, action, AuditLog.Entity.PROJECT, project.name,
                         project=project, changes=changes)
        serializer.instance = self.with_counts(self.get_queryset()).get(pk=project.pk)

    @extend_schema(request=DeleteProjectSerializer, responses={204: None})
    def destroy(self, request, *args, **kwargs):
        project = self.get_object()
        DeleteProjectSerializer(data=request.data, context={"project": project}).is_valid(raise_exception=True)
        return super().destroy(request, *args, **kwargs)

    def perform_destroy(self, instance):
        # Attachment files are removed after commit (see issues/signals.py), so a rollback keeps them.
        with transaction.atomic():
            record_event(self.workspace, self.request.user, AuditLog.Action.DELETED, AuditLog.Entity.PROJECT,
                         instance.name, project_key=instance.key)
            instance.delete()

    @extend_schema(request=WorkflowConfigSerializer, responses=WorkflowConfigSerializer)
    @action(detail=True, methods=["get", "put"], url_path="workflow")
    def workflow(self, request, key=None):
        project = self.get_object()
        workflow = project.workflow
        statuses = list(workflow.statuses.order_by("position", "id"))
        if request.method == "GET":
            index_by_id = {status.id: index for index, status in enumerate(statuses)}
            return Response({
                "name": workflow.name,
                "enforce_transitions": workflow.enforce_transitions,
                "statuses": WorkflowStatusSerializer(statuses, many=True).data,
                "transitions": [
                    {"from": index_by_id[t.from_status_id], "to": index_by_id[t.to_status_id]}
                    for t in workflow.transitions.select_related("from_status", "to_status")
                    if t.from_status_id in index_by_id and t.to_status_id in index_by_id
                ],
            })
        assert_project_writable(project)
        with transaction.atomic():
            # Lock the project first (the shared convention), then re-read and validate under the lock,
            # so no issue can move into a status between validation and its deletion.
            project = lock_project(project.pk, exclusive=True)
            assert_project_writable(project)
            workflow = project.workflow
            statuses = list(workflow.statuses.order_by("position", "id"))
            payload = WorkflowConfigSerializer(data=request.data, context={"project": project})
            payload.is_valid(raise_exception=True)
            data = payload.validated_data
            existing = {status.id: status for status in statuses}
            desired_ids = {item["id"] for item in data["statuses"] if "id" in item}
            removed = set(existing) - desired_ids
            workflow.transitions.all().delete()
            if removed:
                workflow.statuses.filter(id__in=removed).delete()
            ordered = []
            # Temporarily rename statuses to allow safe name swaps under the unique constraint.
            for index, status in enumerate(statuses):
                if status.id in desired_ids:
                    WorkflowStatus.objects.filter(pk=status.pk).update(name=f"{RESERVED_STATUS_PREFIX}{workflow.pk}_{index}__")
            for index, item in enumerate(data["statuses"]):
                status_id = item.get("id")
                status = existing.get(status_id) if status_id else WorkflowStatus(workflow=workflow)
                status.name = item["name"].strip()
                status.category = item["category"]
                status.color = item.get("color", "#64748b")
                status.position = index
                status.save()
                ordered.append(status)
            # One INSERT. bulk_create skips save()'s Python checks; the DB enforces them instead: composite FKs
            # keep both statuses and the workspace consistent with the workflow (projects migration 0008).
            WorkflowTransition.objects.bulk_create([
                WorkflowTransition(workspace=self.workspace, workflow=workflow,
                                   from_status=ordered[transition["from"]], to_status=ordered[transition["to"]])
                for transition in data.get("transitions", [])
            ])
            workflow.name = data.get("name", workflow.name)
            workflow.enforce_transitions = data["enforce_transitions"]
            workflow.save()
            prune_wip_limits(project)
            record_event(self.workspace, request.user, AuditLog.Action.UPDATED, AuditLog.Entity.WORKFLOW, workflow.name,
                         project=project, changes={
                             "statuses": [status.name for status in ordered],
                             "enforce_transitions": workflow.enforce_transitions,
                             "transition_count": len(data.get("transitions", [])),
                         })
        index_by_id = {status.id: index for index, status in enumerate(ordered)}
        return Response({
            "name": workflow.name,
            "enforce_transitions": workflow.enforce_transitions,
            "statuses": WorkflowStatusSerializer(ordered, many=True).data,
            "transitions": [
                {"from": index_by_id[t.from_status_id], "to": index_by_id[t.to_status_id]}
                for t in workflow.transitions.all()
            ],
        })


class BoardViewSet(WorkspaceScopedMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin,
                   mixins.ListModelMixin, viewsets.GenericViewSet):
    serializer_class = BoardSerializer
    required_roles = {"update": Role.ADMIN, "partial_update": Role.ADMIN}
    http_method_names = ["get", "patch"]
    filterset_fields = ["project"]

    def get_queryset(self):
        return Board.objects.for_workspace(self.workspace).select_related("project")

    def perform_update(self, serializer):
        with transaction.atomic():
            # Project first (FOR NO KEY UPDATE: waits for the workflow editor's exclusive lock, so a status can't
            # be removed and pruned mid-PATCH), then the board, RE-READ and RE-VALIDATED: the copy validated so
            # far was loaded without a lock, so its WIP keys and other fields may be stale.
            project = lock_project(serializer.instance.project_id)
            assert_project_writable(project)
            current = Board.objects.select_for_update().select_related("project").get(pk=serializer.instance.pk)
            fresh = self.get_serializer(current, data=self.request.data, partial=True)
            fresh.is_valid(raise_exception=True)
            before = {"wip_limits": current.wip_limits}
            board = fresh.save()  # writes only the submitted fields (BoardSerializer.update)
        serializer.instance = board
        changes = field_changes(board, before, ("wip_limits",))
        if changes:
            record_event(self.workspace, self.request.user, AuditLog.Action.UPDATED, AuditLog.Entity.BOARD, board.name,
                         project=board.project, changes=changes)


def attach_sprint_totals(sprints):
    """Set issue_count / done_count / total_points / done_points on the given sprints with ONE grouped query:
    a single pass over the issues of exactly these sprints (served by the issues (workspace_id, sprint_id)
    index). The previous JOIN + COUNT(DISTINCT) over every issue of the workspace took 133 ms at 100k issues,
    four correlated subqueries still 112 ms (each re-read the same issues)."""
    sprints = list(sprints)
    if not sprints:
        return sprints
    done = Q(status__category=DONE)
    totals = {
        row["sprint_id"]: row
        for row in Issue.objects.filter(workspace_id=sprints[0].workspace_id, sprint_id__in=[s.pk for s in sprints])
        .order_by().values("sprint_id")
        .annotate(issue_count=Count("pk"), done_count=Count("pk", filter=done),
                  total_points=Sum("story_points"), done_points=Sum("story_points", filter=done))
    }
    for sprint in sprints:
        row = totals.get(sprint.pk, {})
        for field in ("issue_count", "done_count", "total_points", "done_points"):
            setattr(sprint, field, row.get(field) or 0)
    return sprints


def sprint_queryset(workspace):
    """Sprints of a workspace; call attach_sprint_totals() on the rows that are shown."""
    return Sprint.objects.for_workspace(workspace).select_related("project")


class SprintViewSet(TenantModelViewSet):
    serializer_class = SprintSerializer
    queryset = Sprint.objects.all()
    required_roles = {"destroy": Role.ADMIN}

    def get_queryset(self):
        # No totals here: they are attached only to the rows a response shows (get_serializer, _refetch), so
        # PATCH, DELETE, start and complete look the sprint up without computing them.
        qs = sprint_queryset(self.workspace)
        params = self.request.query_params
        project = params.get("project")
        if project:
            qs = qs.filter(project_id=project) if project.isdigit() else qs.filter(project__key=project.upper())
        states = [s for s in params.get("state", "").split(",") if s]
        if states:
            qs = qs.filter(state__in=states)
        return qs.order_by("project", "start_date", "id")

    def get_serializer(self, *args, **kwargs):
        if args and self.action in ("list", "retrieve"):
            rows = args[0]
            args = (attach_sprint_totals(rows) if kwargs.get("many") else attach_sprint_totals([rows])[0], *args[1:])
        return super().get_serializer(*args, **kwargs)

    def _refetch(self, sprint):
        return attach_sprint_totals([sprint_queryset(self.workspace).get(pk=sprint.pk)])[0]

    def _audit(self, action, sprint, changes=None):
        record_event(self.workspace, self.request.user, action, AuditLog.Entity.SPRINT, sprint.name,
                     project=sprint.project, changes=changes)

    def perform_create(self, serializer):
        assert_project_writable(serializer.validated_data["project"])
        sprint = serializer.save(workspace=self.workspace)
        self._audit(AuditLog.Action.CREATED, sprint)
        serializer.instance = self._refetch(sprint)

    def perform_update(self, serializer):
        tracked = ("name", "goal", "start_date", "end_date")
        with transaction.atomic():
            # Same convention as start/complete: project first, then the sprint, then RE-READ and re-validate.
            # The instance validated so far was loaded without a lock; start/complete may have changed its
            # state or dates since, and the closed/date rules must see the current row.
            project = lock_project(serializer.instance.project_id)
            assert_project_writable(project)
            current = Sprint.objects.select_for_update().select_related("project").get(pk=serializer.instance.pk)
            fresh = self.get_serializer(current, data=self.request.data, partial=True)
            fresh.is_valid(raise_exception=True)
            before = {field: getattr(current, field) for field in tracked}
            sprint = fresh.save()  # writes only the submitted fields (SprintSerializer.update)
        changes = field_changes(sprint, before, tracked)
        if changes:
            self._audit(AuditLog.Action.UPDATED, sprint, {
                field: {key: str(value) if value is not None else None for key, value in diff.items()}
                for field, diff in changes.items()
            })
        serializer.instance = self._refetch(sprint)

    def perform_destroy(self, instance):
        with transaction.atomic():
            lock_project(instance.project_id, exclusive=True)
            sprint = Sprint.objects.select_for_update().select_related("project").get(pk=instance.pk)
            assert_sprint_deletable(sprint)
            self._audit(AuditLog.Action.DELETED, sprint)
            sprint.delete()  # issues fall back to the backlog (FK is SET_NULL)

    @extend_schema(request=SprintStartSerializer, responses=SprintSerializer)
    @action(detail=True, methods=["post"])
    def start(self, request, pk=None):
        sprint = self.get_object()
        payload = SprintStartSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        try:
            with transaction.atomic():
                # Lock order: project, then sprint. Checks run under the locks, so a double click can't race.
                project = lock_project(sprint.project_id, exclusive=True)
                assert_project_writable(project)
                sprint = Sprint.objects.select_for_update().get(pk=sprint.pk)
                if sprint.state != Sprint.State.PLANNED:
                    raise exceptions.ValidationError("Only planned sprints can be started.")
                if Sprint.objects.filter(project=project, state=Sprint.State.ACTIVE).exists():
                    raise exceptions.ValidationError("This project already has an active sprint. Complete it first.")
                sprint.start_date = data.get("start_date") or sprint.start_date or timezone.localdate()
                sprint.end_date = data.get("end_date") or sprint.end_date or sprint.start_date + timedelta(days=14)
                if sprint.end_date < sprint.start_date:
                    raise exceptions.ValidationError({"end_date": "End date must be on or after the start date."})
                if "goal" in data:
                    sprint.goal = data["goal"]
                sprint.state = Sprint.State.ACTIVE
                sprint.save()
                self._audit(AuditLog.Action.STARTED, sprint)
        except IntegrityError:  # one_active_sprint_per_project is the final safeguard
            raise exceptions.ValidationError("This project already has an active sprint. Complete it first.")
        return Response(SprintSerializer(self._refetch(sprint), context=self.get_serializer_context()).data)

    @extend_schema(request=SprintCompleteSerializer, responses=SprintSerializer)
    @action(detail=True, methods=["post"])
    def complete(self, request, pk=None):
        sprint = self.get_object()
        payload = SprintCompleteSerializer(data=request.data, context=self.get_serializer_context())
        payload.is_valid(raise_exception=True)
        target = payload.validated_data["move_open_issues_to"]
        with transaction.atomic():
            project = lock_project(sprint.project_id, exclusive=True)
            assert_project_writable(project)
            sprint = Sprint.objects.select_for_update().get(pk=sprint.pk)
            # Re-checked under the lock: a repeated request gets a 400 and causes no second event.
            if sprint.state != Sprint.State.ACTIVE:
                raise exceptions.ValidationError("Only the active sprint can be completed.")
            if target is not None:
                target = Sprint.objects.select_for_update().get(pk=target.pk)
                if target.project_id != sprint.project_id or target.state != Sprint.State.PLANNED:
                    raise exceptions.ValidationError({"move_open_issues_to": "Pick a planned sprint of the same project."})
            moved = sprint.issues.exclude(status__category=DONE).update(sprint=target, updated_at=timezone.now())
            sprint.state = Sprint.State.CLOSED
            sprint.completed_at = timezone.now()
            sprint.save()
            self._audit(AuditLog.Action.COMPLETED, sprint, {
                "open_issues_moved": moved, "moved_to": target.name if target else "Backlog",
            })
        return Response(SprintSerializer(self._refetch(sprint), context=self.get_serializer_context()).data)
