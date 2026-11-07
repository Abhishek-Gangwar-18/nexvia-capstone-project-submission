from django.db import IntegrityError, transaction
from django.http import FileResponse
from django.contrib.auth import get_user_model
from django.utils.http import content_disposition_header
from drf_spectacular.openapi import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import exceptions, mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from apps.billing.limits import check_file_size
from apps.core.api import TenantModelViewSet, WorkspaceScopedMixin
from apps.core.pagination import AlwaysPageNumberPagination, CappedListMixin, paginate_or_cap
from apps.tenants.models import Membership

from .activity import mentioned_members, record_event, record_issue_event
from .filters import AuditLogFilter, IssueFilter
from .models import Issue, IssueAttachment, AuditLog, IssueComment, Label
from apps.projects.models import Sprint, WorkflowStatus
from apps.projects.services import ARCHIVED_MESSAGE, lock_project
from .serializers import (
    IssueAttachmentSerializer, IssueAttachmentUploadSerializer, AuditLogSerializer,
    IssueCommentCreateSerializer, IssueCommentSerializer, IssueDetailSerializer, IssueListSerializer,
    IssueMoveSerializer, IssueSerializer, LabelSerializer,
)
from .services import (
    UNSET, add_attachment, add_comment, can_delete_comment, can_edit_comment, delete_attachment, delete_comment,
    delete_issue, edit_comment, move_issue, validate_hierarchy,
)

Role = Membership.Role


def display_issue_value(field, value, workspace):
    if value is None:
        return None
    if field == "status_id":
        return WorkflowStatus.objects.filter(workspace=workspace, pk=value).values_list("name", flat=True).first()
    if field == "sprint_id":
        return Sprint.objects.filter(workspace=workspace, pk=value).values_list("name", flat=True).first()
    if field == "parent_id":
        return Issue.objects.filter(workspace=workspace, pk=value).values_list("key", flat=True).first()
    if field == "assignee_id":
        user = get_user_model().objects.filter(pk=value).first()
        return user.display_name if user else None
    if field == "issue_type":
        return dict(Issue.IssueType.choices).get(value, value)
    if field == "priority":
        return dict(Issue.Priority.choices).get(value, value)
    return value.isoformat() if hasattr(value, "isoformat") else value


@extend_schema_view(update=extend_schema(exclude=True))  # PUT /issues/{key}/ is gone; use PATCH
class IssueViewSet(CappedListMixin, TenantModelViewSet):
    queryset = Issue.objects.all()
    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z][A-Za-z0-9]*-\d+"
    filterset_class = IssueFilter
    search_fields = ["key", "title", "description"]
    ordering_fields = ["rank", "created_at", "updated_at", "priority", "due_date", "number", "story_points"]
    ordering = ["rank", "id"]

    def get_queryset(self):
        return (
            super().get_queryset()
            .select_related("project", "status", "sprint", "parent", "assignee", "reporter")
            .prefetch_related("labels")
        )

    def get_serializer_class(self):
        if self.action == "list":
            return IssueListSerializer
        if self.action == "retrieve":
            return IssueDetailSerializer
        return IssueSerializer

    def get_object(self):
        self.kwargs[self.lookup_field] = self.kwargs[self.lookup_field].upper()
        return super().get_object()

    def update(self, request, *args, **kwargs):
        if not kwargs.get("partial"):
            raise exceptions.MethodNotAllowed("PUT", detail="Use PATCH to update an issue.")
        return super().update(request, *args, **kwargs)

    def list(self, request, *args, **kwargs):
        # Unpaged lists (board, backlog, pickers, command palette) must be narrowed; ?page= is unrestricted.
        params = request.query_params
        if "page" not in params and not (params.get("project", "").strip() or params.get("search", "").strip()):
            raise exceptions.ValidationError({"detail": "Filter by project or search, or request a page with ?page=."})
        return super().list(request, *args, **kwargs)

    def _locked_status_check(self, serializer, project, instance=None):
        """Take the shared project lock, then re-check what concurrent edits could invalidate:
        the chosen status still exists, and the parent/type hierarchy (including cycles) still holds."""
        project = lock_project(project.pk)
        if project.is_archived:
            raise exceptions.ValidationError({"project": [ARCHIVED_MESSAGE]})
        data = serializer.validated_data
        status = data.get("status")
        if status is not None and not WorkflowStatus.objects.filter(pk=status.pk).exists():
            raise exceptions.ValidationError({"status": ["This status no longer exists. Reload and try again."]})
        parent = data["parent"] if "parent" in data else getattr(instance, "parent", None)
        if parent is not None:
            parent = Issue.objects.filter(pk=parent.pk).first()  # fresh row: its own parent may have changed
            if parent is None:
                raise exceptions.ValidationError({"parent": ["The parent issue no longer exists."]})
        issue_type = data.get("issue_type", getattr(instance, "issue_type", Issue.IssueType.TASK))
        validate_hierarchy(
            project=project, instance=instance, issue_type=issue_type, parent=parent,
            parent_changed=instance is None or ("parent" in data and data["parent"] != instance.parent),
            type_changed=instance is not None and issue_type != instance.issue_type,
        )

    def perform_create(self, serializer):
        with transaction.atomic():
            self._locked_status_check(serializer, serializer.validated_data["project"])
            issue = serializer.save(workspace=self.workspace, reporter=self.request.user)
        record_issue_event(issue, self.request.user, AuditLog.Action.CREATED, {"title": {"to": issue.title}})

    def perform_update(self, serializer):
        issue = serializer.instance
        tracked = ("title", "description", "issue_type", "priority", "status_id", "sprint_id", "parent_id",
                   "assignee_id", "story_points", "due_date")
        before = {name: getattr(issue, name) for name in tracked}
        before_labels = set(issue.labels.values_list("name", flat=True))
        with transaction.atomic():
            self._locked_status_check(serializer, issue.project, instance=issue)
            serializer.save()
        changes = {}
        for name in tracked:
            old, new = before[name], getattr(issue, name)
            if old != new:
                label = name.removesuffix("_id")
                changes[label] = {
                    "from": display_issue_value(name, old, self.workspace),
                    "to": display_issue_value(name, new, self.workspace),
                }
        after_labels = set(issue.labels.values_list("name", flat=True))
        if before_labels != after_labels:
            changes["labels"] = {"from": sorted(before_labels), "to": sorted(after_labels)}
        if changes:
            record_issue_event(issue, self.request.user, AuditLog.Action.UPDATED, changes)

    def perform_destroy(self, instance):
        if instance.reporter_id != self.request.user.id and not self.membership.has_role(Role.ADMIN):
            raise exceptions.PermissionDenied("Only the reporter or a workspace admin can delete this issue.")
        with transaction.atomic():
            record_issue_event(instance, self.request.user, AuditLog.Action.DELETED, {"title": {"from": instance.title}})
            delete_issue(instance)

    @extend_schema(request=IssueMoveSerializer, responses=IssueSerializer)
    @action(detail=True, methods=["post"])
    def move(self, request, key=None):
        issue = self.get_object()
        old_status_id, old_status = issue.status_id, issue.status.name
        old_sprint_id, old_sprint = issue.sprint_id, issue.sprint.name if issue.sprint_id else None
        payload = IssueMoveSerializer(data=request.data, context=self.get_serializer_context())
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        move_issue(
            issue,
            status=data.get("status"),
            sprint=data["sprint"] if "sprint" in data else UNSET,
            prev_id=data.get("prev_id"),
            next_id=data.get("next_id"),
        )
        issue.refresh_from_db()
        # Reordering inside a column is not an event: it would spam the log, webhooks and notifications.
        changes = {}
        if old_status_id != issue.status_id:
            changes["status"] = {"from": old_status, "to": issue.status.name}
        if old_sprint_id != issue.sprint_id:
            changes["sprint"] = {"from": old_sprint, "to": issue.sprint.name if issue.sprint_id else None}
        if changes:
            record_issue_event(issue, request.user, AuditLog.Action.MOVED, changes)
        return Response(IssueSerializer(self.get_queryset().get(pk=issue.pk), context=self.get_serializer_context()).data)

    @extend_schema(responses=IssueCommentSerializer(many=True), request=IssueCommentCreateSerializer)
    @action(detail=True, methods=["get", "post"], url_path="comments")
    def comments(self, request, key=None):
        issue = self.get_object()
        if request.method == "GET":
            # Conversation order (oldest first). Unpaged: the latest 200; ?page= pages 50 at a time.
            comments = issue.comments.select_related("author").prefetch_related("mentions").order_by("created_at", "id")
            return paginate_or_cap(self, request, comments, IssueCommentSerializer, newest_first=False)
        payload = IssueCommentCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        body = payload.validated_data["body"]
        with transaction.atomic():
            comment = add_comment(issue, request.user, body, mentioned_members(self.workspace, body))
            record_issue_event(issue, request.user, AuditLog.Action.COMMENTED, {"comment_id": comment.pk})
        return Response(IssueCommentSerializer(comment).data, status=status.HTTP_201_CREATED)

    @extend_schema(parameters=[OpenApiParameter("comment_id", int, OpenApiParameter.PATH)])
    @action(detail=True, methods=["patch", "delete"], url_path=r"comments/(?P<comment_id>\d+)")
    def comment_detail(self, request, key=None, comment_id=None):
        issue = self.get_object()
        comment = issue.comments.select_related("author").filter(pk=comment_id).first()
        if comment is None:
            raise exceptions.NotFound("Comment not found.")
        if request.method == "DELETE":
            if not can_delete_comment(comment, self.membership):
                raise exceptions.PermissionDenied("Only the comment author or a workspace admin can delete this comment.")
            with transaction.atomic():
                record_issue_event(issue, request.user, AuditLog.Action.COMMENTED,
                                   {"comment_id": comment.pk, "deleted": True})
                delete_comment(comment)
            return Response(status=status.HTTP_204_NO_CONTENT)
        if not can_edit_comment(comment, request.user):
            raise exceptions.PermissionDenied("Only the comment's author can edit it.")
        payload = IssueCommentCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        body = payload.validated_data["body"]
        with transaction.atomic():
            added = edit_comment(comment, body, mentioned_members(self.workspace, body))
            # Only newly added mentions are notified; the event is dispatched on commit.
            record_issue_event(issue, request.user, AuditLog.Action.COMMENTED,
                               {"comment_id": comment.pk, "edited": True, "new_mentions": added})
        return Response(IssueCommentSerializer(comment).data)

    @extend_schema(responses=IssueAttachmentSerializer(many=True), request=IssueAttachmentUploadSerializer)
    @action(detail=True, methods=["get", "post"], url_path="attachments", parser_classes=[MultiPartParser, FormParser])
    def attachments(self, request, key=None):
        issue = self.get_object()
        if request.method == "GET":
            return Response(IssueAttachmentSerializer(issue.attachments.select_related("uploaded_by"), many=True).data)
        payload = IssueAttachmentUploadSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        uploaded = payload.validated_data["file"]
        check_file_size(self.workspace, uploaded.size)
        attachment = add_attachment(
            issue, request.user, uploaded,
            record=lambda a: record_issue_event(issue, request.user, AuditLog.Action.ATTACHED,
                                                {"attachment_id": a.pk, "name": a.original_name}),
        )
        return Response(IssueAttachmentSerializer(attachment).data, status=status.HTTP_201_CREATED)

    @extend_schema(responses=AuditLogSerializer(many=True))
    @action(detail=True, methods=["get"], url_path="activity")
    def activity(self, request, key=None):
        issue = self.get_object()
        events = AuditLog.objects.for_workspace(self.workspace).filter(
            project_id=issue.project_id, issue_key=issue.key
        ).select_related("actor").order_by("-created_at", "-id")
        return paginate_or_cap(self, request, events, AuditLogSerializer, newest_first=True)


class IssueAttachmentViewSet(WorkspaceScopedMixin, viewsets.GenericViewSet):
    queryset = IssueAttachment.objects.all()
    serializer_class = IssueAttachmentSerializer
    lookup_value_regex = r"\d+"
    required_roles = {"destroy": Role.MEMBER, "download": Role.VIEWER}

    def get_queryset(self):
        return IssueAttachment.objects.for_workspace(self.workspace).select_related("issue", "uploaded_by")

    @extend_schema(responses={200: OpenApiTypes.BINARY})
    @action(detail=True, methods=["get"], url_path="download")
    def download(self, request, pk=None):
        attachment = self.get_object()
        try:
            handle = attachment.file.open("rb")
        except FileNotFoundError:
            raise exceptions.NotFound("This file is no longer available.")
        response = FileResponse(handle, content_type="application/octet-stream")
        response["Content-Disposition"] = content_disposition_header(True, attachment.original_name)
        response["X-Content-Type-Options"] = "nosniff"
        return response

    def destroy(self, request, *args, **kwargs):
        attachment = self.get_object()
        if attachment.uploaded_by_id != request.user.id and not request.membership.has_role(Role.ADMIN):
            raise exceptions.PermissionDenied("Only the uploader or a workspace admin can remove this attachment.")
        issue = attachment.issue
        name = attachment.original_name
        with transaction.atomic():
            delete_attachment(attachment)  # the file itself is removed after commit
            record_issue_event(issue, request.user, AuditLog.Action.DETACHED,
                               {"attachment_id": kwargs["pk"], "name": name})
        return Response(status=status.HTTP_204_NO_CONTENT)


class LabelViewSet(TenantModelViewSet):
    queryset = Label.objects.all()
    serializer_class = LabelSerializer
    required_roles = {"destroy": Role.ADMIN}
    search_fields = ["name"]

    def perform_create(self, serializer):
        try:
            with transaction.atomic():
                label = serializer.save(workspace=self.workspace)
        except IntegrityError:  # unique (workspace, name) is the final safeguard
            raise exceptions.ValidationError({"name": ["A label with this name already exists."]})
        record_event(self.workspace, self.request.user, AuditLog.Action.CREATED, AuditLog.Entity.LABEL, label.name)

    def perform_update(self, serializer):
        try:
            with transaction.atomic():
                serializer.save()
        except IntegrityError:
            raise exceptions.ValidationError({"name": ["A label with this name already exists."]})

    def perform_destroy(self, instance):
        record_event(self.workspace, self.request.user, AuditLog.Action.DELETED, AuditLog.Entity.LABEL, instance.name)
        instance.delete()


class AuditLogViewSet(WorkspaceScopedMixin, mixins.ListModelMixin, viewsets.GenericViewSet):
    """Workspace-wide history for admins. Read-only: the API offers no way to edit or delete it."""

    serializer_class = AuditLogSerializer
    pagination_class = AlwaysPageNumberPagination  # never an unbounded history, even without ?page=
    required_roles = {"list": Role.ADMIN}
    filterset_class = AuditLogFilter
    search_fields = ["entity_label"]
    ordering_fields = ["created_at"]
    ordering = ["-created_at", "-id"]

    def get_queryset(self):
        return AuditLog.objects.for_workspace(self.workspace).select_related("actor")
