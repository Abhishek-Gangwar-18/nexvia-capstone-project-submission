from django.http import FileResponse
from django.contrib.auth import get_user_model
from django.utils.http import content_disposition_header
from drf_spectacular.openapi import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import exceptions, status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from apps.core.api import TenantModelViewSet, WorkspaceScopedMixin
from apps.tenants.models import Membership

from .activity import mentioned_members, record_issue_event
from .filters import IssueFilter
from .models import Issue, IssueAttachment, IssueAuditLog, IssueComment, Label
from apps.projects.models import Sprint, WorkflowStatus
from .serializers import (
    IssueAttachmentSerializer, IssueAttachmentUploadSerializer, IssueAuditLogSerializer,
    IssueCommentCreateSerializer, IssueCommentSerializer, IssueDetailSerializer, IssueListSerializer,
    IssueMoveSerializer, IssueSerializer, LabelSerializer,
)
from .services import UNSET, move_issue

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


class IssueViewSet(TenantModelViewSet):
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

    def perform_create(self, serializer):
        issue = serializer.save(workspace=self.workspace, reporter=self.request.user)
        record_issue_event(issue, self.request.user, IssueAuditLog.Action.CREATED, {"title": {"to": issue.title}})

    def perform_update(self, serializer):
        issue = serializer.instance
        tracked = ("title", "description", "issue_type", "priority", "status_id", "sprint_id", "parent_id",
                   "assignee_id", "story_points", "due_date")
        before = {name: getattr(issue, name) for name in tracked}
        before_labels = set(issue.labels.values_list("name", flat=True))
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
            record_issue_event(issue, self.request.user, IssueAuditLog.Action.UPDATED, changes)

    def perform_destroy(self, instance):
        if instance.reporter_id != self.request.user.id and not self.membership.has_role(Role.ADMIN):
            raise exceptions.PermissionDenied("Only the reporter or a workspace admin can delete this issue.")
        record_issue_event(instance, self.request.user, IssueAuditLog.Action.DELETED, {"title": {"from": instance.title}})
        instance.delete()

    @extend_schema(request=IssueMoveSerializer, responses=IssueSerializer)
    @action(detail=True, methods=["post"])
    def move(self, request, key=None):
        issue = self.get_object()
        old_status, old_sprint = issue.status.name, issue.sprint.name if issue.sprint_id else None
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
        if old_status != issue.status_id or old_sprint != issue.sprint_id:
            record_issue_event(issue, request.user, IssueAuditLog.Action.MOVED, {
                "status": {"from": old_status, "to": issue.status.name},
                "sprint": {"from": old_sprint, "to": issue.sprint.name if issue.sprint_id else None},
            })
        return Response(IssueSerializer(self.get_queryset().get(pk=issue.pk), context=self.get_serializer_context()).data)

    @extend_schema(responses=IssueCommentSerializer(many=True), request=IssueCommentCreateSerializer)
    @action(detail=True, methods=["get", "post"], url_path="comments")
    def comments(self, request, key=None):
        issue = self.get_object()
        if request.method == "GET":
            comments = issue.comments.select_related("author").prefetch_related("mentions")
            return Response(IssueCommentSerializer(comments, many=True).data)
        payload = IssueCommentCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        comment = IssueComment.objects.create(
            workspace=self.workspace, issue=issue, author=request.user, body=payload.validated_data["body"]
        )
        comment.mentions.set(mentioned_members(self.workspace, comment.body))
        record_issue_event(issue, request.user, IssueAuditLog.Action.COMMENTED, {"comment_id": comment.pk})
        return Response(IssueCommentSerializer(comment).data, status=status.HTTP_201_CREATED)

    @extend_schema(parameters=[OpenApiParameter("comment_id", int, OpenApiParameter.PATH)])
    @action(detail=True, methods=["patch", "delete"], url_path=r"comments/(?P<comment_id>[^/.]+)")
    def comment_detail(self, request, key=None, comment_id=None):
        issue = self.get_object()
        comment = issue.comments.select_related("author").filter(pk=comment_id).first()
        if comment is None:
            raise exceptions.NotFound("Comment not found.")
        if comment.author_id != request.user.id and not self.membership.has_role(Role.ADMIN):
            raise exceptions.PermissionDenied("Only the comment author or a workspace admin can change this comment.")
        if request.method == "DELETE":
            record_issue_event(issue, request.user, IssueAuditLog.Action.COMMENTED,
                               {"comment_id": comment.pk, "deleted": True})
            comment.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        payload = IssueCommentCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        comment.body = payload.validated_data["body"]
        comment.save(update_fields=["body", "updated_at"])
        comment.mentions.set(mentioned_members(self.workspace, comment.body))
        record_issue_event(issue, request.user, IssueAuditLog.Action.COMMENTED,
                           {"comment_id": comment.pk, "edited": True})
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
        attachment = IssueAttachment.objects.create(
            workspace=self.workspace,
            issue=issue,
            uploaded_by=request.user,
            file=uploaded,
            original_name=uploaded.name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1][:255],
            content_type=uploaded.content_type or "application/octet-stream",
            size=uploaded.size,
        )
        record_issue_event(issue, request.user, IssueAuditLog.Action.ATTACHED,
                           {"attachment_id": attachment.pk, "name": attachment.original_name})
        return Response(IssueAttachmentSerializer(attachment).data, status=status.HTTP_201_CREATED)

    @extend_schema(responses=IssueAuditLogSerializer(many=True))
    @action(detail=True, methods=["get"], url_path="activity")
    def activity(self, request, key=None):
        issue = self.get_object()
        events = IssueAuditLog.objects.for_workspace(self.workspace).filter(
            project_id=issue.project_id, issue_key=issue.key
        ).select_related("actor")
        return Response(IssueAuditLogSerializer(events, many=True).data)


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
        response = FileResponse(attachment.file.open("rb"), content_type="application/octet-stream")
        response["Content-Disposition"] = content_disposition_header(True, attachment.original_name)
        response["X-Content-Type-Options"] = "nosniff"
        return response

    def destroy(self, request, *args, **kwargs):
        attachment = self.get_object()
        if attachment.uploaded_by_id != request.user.id and not request.membership.has_role(Role.ADMIN):
            raise exceptions.PermissionDenied("Only the uploader or a workspace admin can remove this attachment.")
        issue = attachment.issue
        name = attachment.original_name
        attachment.file.delete(save=False)
        attachment.delete()
        record_issue_event(issue, request.user, IssueAuditLog.Action.DETACHED,
                           {"attachment_id": kwargs["pk"], "name": name})
        return Response(status=status.HTTP_204_NO_CONTENT)


class LabelViewSet(TenantModelViewSet):
    queryset = Label.objects.all()
    serializer_class = LabelSerializer
    required_roles = {"destroy": Role.ADMIN}
    search_fields = ["name"]
