from datetime import timedelta

from django.db import transaction
from django.db.models import Count, IntegerField, Prefetch, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import exceptions, mixins, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.api import TenantModelViewSet, WorkspaceScopedMixin
from apps.tenants.models import Membership

from .models import Board, Project, Sprint, WorkflowStatus
from .serializers import (
    BoardSerializer, ProjectSerializer, SprintCompleteSerializer, SprintSerializer, SprintStartSerializer,
)
from .services import create_project

Role = Membership.Role
DONE = WorkflowStatus.Category.DONE


class ProjectViewSet(TenantModelViewSet):
    serializer_class = ProjectSerializer
    queryset = Project.objects.all()
    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z][A-Za-z0-9]{1,9}"
    required_roles = {"create": Role.ADMIN, "update": Role.ADMIN, "partial_update": Role.ADMIN, "destroy": Role.ADMIN}
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
            .annotate(
                issue_count=Count("issues", distinct=True),
                done_count=Count("issues", filter=Q(issues__status__category=DONE), distinct=True),
            )
        )

    def perform_create(self, serializer):
        data = serializer.validated_data
        project = create_project(
            workspace=self.workspace, created_by=self.request.user,
            name=data["name"], key=data["key"], description=data.get("description", ""),
            color=data.get("color", "#6366f1"), lead=data.get("lead"), board_type=data.get("board_type"),
        )
        serializer.instance = self.get_queryset().get(pk=project.pk)

    def perform_update(self, serializer):
        serializer.validated_data.pop("board_type", None)
        project = serializer.save()
        serializer.instance = self.get_queryset().get(pk=project.pk)


class BoardViewSet(WorkspaceScopedMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin,
                   mixins.ListModelMixin, viewsets.GenericViewSet):
    serializer_class = BoardSerializer
    required_roles = {"update": Role.ADMIN, "partial_update": Role.ADMIN}
    http_method_names = ["get", "patch"]
    filterset_fields = ["project"]

    def get_queryset(self):
        return Board.objects.for_workspace(self.workspace)


def sprint_queryset(workspace):
    done = Q(issues__status__category=DONE)
    return (
        Sprint.objects.for_workspace(workspace)
        .select_related("project")
        .annotate(
            issue_count=Count("issues", distinct=True),
            done_count=Count("issues", filter=done, distinct=True),
            total_points=Coalesce(Sum("issues__story_points"), Value(0), output_field=IntegerField()),
            done_points=Coalesce(Sum("issues__story_points", filter=done), Value(0), output_field=IntegerField()),
        )
    )


class SprintViewSet(TenantModelViewSet):
    serializer_class = SprintSerializer
    queryset = Sprint.objects.all()
    required_roles = {"destroy": Role.ADMIN}

    def get_queryset(self):
        qs = sprint_queryset(self.workspace)
        params = self.request.query_params
        project = params.get("project")
        if project:
            qs = qs.filter(project_id=project) if project.isdigit() else qs.filter(project__key=project.upper())
        states = [s for s in params.get("state", "").split(",") if s]
        if states:
            qs = qs.filter(state__in=states)
        return qs.order_by("project", "start_date", "id")

    def _refetch(self, sprint):
        return sprint_queryset(self.workspace).get(pk=sprint.pk)

    def perform_create(self, serializer):
        serializer.instance = self._refetch(serializer.save(workspace=self.workspace))

    def perform_update(self, serializer):
        serializer.instance = self._refetch(serializer.save())

    def perform_destroy(self, instance):
        if instance.state == Sprint.State.ACTIVE:
            raise exceptions.ValidationError("Complete the sprint before deleting it.")
        instance.delete()  # issues fall back to the backlog (FK is SET_NULL)

    @extend_schema(request=SprintStartSerializer, responses=SprintSerializer)
    @action(detail=True, methods=["post"])
    def start(self, request, pk=None):
        sprint = self.get_object()
        if sprint.state != Sprint.State.PLANNED:
            raise exceptions.ValidationError("Only planned sprints can be started.")
        if Sprint.objects.filter(project=sprint.project, state=Sprint.State.ACTIVE).exists():
            raise exceptions.ValidationError("This project already has an active sprint. Complete it first.")
        payload = SprintStartSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        sprint.start_date = data.get("start_date") or sprint.start_date or timezone.localdate()
        sprint.end_date = data.get("end_date") or sprint.end_date or sprint.start_date + timedelta(days=14)
        if sprint.end_date < sprint.start_date:
            raise exceptions.ValidationError({"end_date": "End date must be on or after the start date."})
        if "goal" in data:
            sprint.goal = data["goal"]
        sprint.state = Sprint.State.ACTIVE
        sprint.save()
        return Response(SprintSerializer(self._refetch(sprint), context=self.get_serializer_context()).data)

    @extend_schema(request=SprintCompleteSerializer, responses=SprintSerializer)
    @action(detail=True, methods=["post"])
    def complete(self, request, pk=None):
        sprint = self.get_object()
        if sprint.state != Sprint.State.ACTIVE:
            raise exceptions.ValidationError("Only the active sprint can be completed.")
        payload = SprintCompleteSerializer(data=request.data, context=self.get_serializer_context())
        payload.is_valid(raise_exception=True)
        target = payload.validated_data["move_open_issues_to"]
        if target and (target.project_id != sprint.project_id or target.state != Sprint.State.PLANNED):
            raise exceptions.ValidationError({"move_open_issues_to": "Pick a planned sprint of the same project."})
        with transaction.atomic():
            sprint.issues.exclude(status__category=DONE).update(sprint=target, updated_at=timezone.now())
            sprint.state = Sprint.State.CLOSED
            sprint.completed_at = timezone.now()
            sprint.save()
        return Response(SprintSerializer(self._refetch(sprint), context=self.get_serializer_context()).data)
