import mimetypes
from pathlib import PurePath

from django.conf import settings
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.accounts.serializers import UserMiniSerializer
from apps.core.fields import TenantPrimaryKeyRelatedField, WorkspaceMemberField
from apps.projects.models import Project, Sprint, WorkflowStatus

from .models import Issue, IssueAttachment, AuditLog, IssueComment, Label


class LabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Label
        fields = ["id", "name", "color"]

    def validate_name(self, value):
        value = value.strip().lower()
        workspace = self.context["request"].workspace
        clash = Label.objects.for_workspace(workspace).filter(name=value)
        if self.instance:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError("A label with this name already exists.")
        return value


class IssueRefSerializer(serializers.ModelSerializer):
    class Meta:
        model = Issue
        fields = ["id", "key", "title", "issue_type"]


class IssueSummarySerializer(serializers.ModelSerializer):
    status_category = serializers.CharField(source="status.category", read_only=True)
    assignee_detail = UserMiniSerializer(source="assignee", read_only=True)

    class Meta:
        model = Issue
        fields = ["id", "key", "title", "issue_type", "priority", "status", "status_category", "assignee_detail"]


class IssueSerializer(serializers.ModelSerializer):
    project = TenantPrimaryKeyRelatedField(queryset=Project.objects.all())
    project_key = serializers.CharField(source="project.key", read_only=True)
    status = TenantPrimaryKeyRelatedField(queryset=WorkflowStatus.objects.all(), required=False)
    status_category = serializers.CharField(source="status.category", read_only=True)
    sprint = TenantPrimaryKeyRelatedField(queryset=Sprint.objects.all(), required=False, allow_null=True)
    parent = TenantPrimaryKeyRelatedField(queryset=Issue.objects.all(), required=False, allow_null=True)
    parent_summary = IssueRefSerializer(source="parent", read_only=True, allow_null=True)
    assignee = WorkspaceMemberField(required=False, allow_null=True)
    assignee_detail = UserMiniSerializer(source="assignee", read_only=True)
    reporter_detail = UserMiniSerializer(source="reporter", read_only=True)
    labels = TenantPrimaryKeyRelatedField(queryset=Label.objects.all(), many=True, required=False)

    class Meta:
        model = Issue
        fields = [
            "id", "key", "number", "project", "project_key", "title", "description", "issue_type", "priority",
            "status", "status_category", "sprint", "parent", "parent_summary", "assignee", "assignee_detail",
            "reporter_detail", "story_points", "due_date", "rank", "labels", "resolved_at", "created_at", "updated_at",
        ]
        read_only_fields = ["key", "number", "rank", "resolved_at", "created_at", "updated_at"]

    def validate_title(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Title can't be empty.")
        return value

    def validate(self, attrs):
        instance = self.instance
        project = attrs.get("project") or getattr(instance, "project", None)
        errors = {}
        if project is not None and project.is_archived:
            raise serializers.ValidationError({"project": "This project is archived. Restore it to make changes."})
        if instance and "project" in attrs and attrs["project"].pk != instance.project_id:
            errors["project"] = "Issues can't be moved between projects."

        status = attrs.get("status")
        if status is not None:
            if status.workflow.project_id != project.pk:
                errors["status"] = "This status belongs to a different project."
            elif instance and status.pk != instance.status_id and not project.workflow.can_transition(
                instance.status, status
            ):
                errors["status"] = f"Transition '{instance.status.name}' → '{status.name}' is not allowed."

        sprint = attrs.get("sprint")
        if sprint is not None:
            if sprint.project_id != project.pk:
                errors["sprint"] = "This sprint belongs to a different project."
            elif sprint.state == Sprint.State.CLOSED and (not instance or instance.sprint_id != sprint.pk):
                errors["sprint"] = "Issues can't be added to a closed sprint."

        parent = attrs.get("parent")
        if parent is not None:
            if parent.project_id != project.pk:
                errors["parent"] = "The parent issue belongs to a different project."
            elif instance and parent.pk == instance.pk:
                errors["parent"] = "An issue can't be its own parent."
            elif parent.issue_type != Issue.IssueType.EPIC and attrs.get(
                "issue_type", getattr(instance, "issue_type", None)
            ) != Issue.IssueType.SUBTASK:
                errors["parent"] = "Only sub-tasks can have a non-epic parent."

        if errors:
            raise serializers.ValidationError(errors)
        return attrs


class IssueListSerializer(IssueSerializer):
    class Meta(IssueSerializer.Meta):
        fields = [f for f in IssueSerializer.Meta.fields if f != "description"]


class IssueDetailSerializer(IssueSerializer):
    children = serializers.SerializerMethodField()

    class Meta(IssueSerializer.Meta):
        fields = [*IssueSerializer.Meta.fields, "children"]

    @extend_schema_field(IssueSummarySerializer(many=True))
    def get_children(self, obj):
        children = obj.children.select_related("status", "assignee").order_by("rank", "id")
        return IssueSummarySerializer(children, many=True).data


class IssueMoveSerializer(serializers.Serializer):
    status = TenantPrimaryKeyRelatedField(queryset=WorkflowStatus.objects.all(), required=False)
    sprint = TenantPrimaryKeyRelatedField(queryset=Sprint.objects.all(), required=False, allow_null=True)
    prev_id = serializers.IntegerField(required=False, allow_null=True, help_text="Issue now directly above")
    next_id = serializers.IntegerField(required=False, allow_null=True, help_text="Issue now directly below")


class IssueCommentSerializer(serializers.ModelSerializer):
    author = UserMiniSerializer(read_only=True)
    mentions = UserMiniSerializer(many=True, read_only=True)

    class Meta:
        model = IssueComment
        fields = ["id", "body", "author", "mentions", "created_at", "updated_at"]
        read_only_fields = fields


class IssueCommentCreateSerializer(serializers.Serializer):
    body = serializers.CharField(max_length=10000, allow_blank=False, trim_whitespace=True)

    def validate_body(self, value):
        if not value.strip():
            raise serializers.ValidationError("Comment cannot be empty.")
        return value.strip()


class IssueAttachmentSerializer(serializers.ModelSerializer):
    uploaded_by = UserMiniSerializer(read_only=True)
    download_url = serializers.SerializerMethodField()

    class Meta:
        model = IssueAttachment
        fields = ["id", "original_name", "content_type", "size", "uploaded_by", "download_url", "created_at"]
        read_only_fields = fields

    @extend_schema_field(serializers.URLField())
    def get_download_url(self, obj):
        return f"/api/attachments/{obj.pk}/download/"


class IssueAttachmentUploadSerializer(serializers.Serializer):
    file = serializers.FileField()
    MAX_SIZE = 25 * 1024 * 1024
    ALLOWED_TYPES = {
        ".csv": {"text/csv", "application/vnd.ms-excel"},
        ".gif": {"image/gif"},
        ".jpeg": {"image/jpeg"},
        ".jpg": {"image/jpeg"},
        ".md": {"text/markdown", "text/plain"},
        ".pdf": {"application/pdf"},
        ".png": {"image/png"},
        ".txt": {"text/plain"},
        ".webp": {"image/webp"},
        ".zip": {"application/zip", "application/x-zip-compressed"},
    }

    def validate_file(self, value):
        if value.size > self.MAX_SIZE:
            raise serializers.ValidationError("File exceeds the 25 MB limit.")
        extension = PurePath(value.name).suffix.lower()
        allowed = self.ALLOWED_TYPES.get(extension)
        if not allowed:
            raise serializers.ValidationError("Unsupported file type. Allowed: CSV, GIF, JPEG, Markdown, PDF, PNG, TXT, WebP, ZIP.")
        content_type = (value.content_type or mimetypes.guess_type(value.name)[0] or "").lower()
        if content_type not in allowed and content_type != "application/octet-stream":
            raise serializers.ValidationError("File extension and content type do not match.")
        return value


class AuditLogSerializer(serializers.ModelSerializer):
    actor = UserMiniSerializer(read_only=True)

    class Meta:
        model = AuditLog
        fields = ["id", "entity_type", "entity_label", "project_key", "issue_key", "issue_title", "actor", "action", "changes", "created_at"]
