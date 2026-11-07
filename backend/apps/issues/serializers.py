import calendar
import codecs
import re
from datetime import date
from pathlib import PurePath

from django.conf import settings
from django.utils import timezone
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.projects.services import ARCHIVED_MESSAGE

from apps.accounts.serializers import UserMiniSerializer
from apps.core.fields import TenantPrimaryKeyRelatedField, WorkspaceMemberField
from apps.projects.models import Project, Sprint, WorkflowStatus

from .models import Issue, IssueAttachment, AuditLog, IssueComment, Label


HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
DUE_DATE_YEARS = 10
STORY_POINTS_MAX = 100


def shift_years(day, years):
    """Same calendar day `years` away; Feb 29 falls back to Feb 28 in non-leap years."""
    year = day.year + years
    return date(year, day.month, min(day.day, calendar.monthrange(year, day.month)[1]))


class StrictIntegerField(serializers.IntegerField):
    """A JSON integer only: true/false, 2.5 and "3" are rejected instead of coerced."""

    def to_internal_value(self, data):
        if isinstance(data, bool) or not isinstance(data, int):
            self.fail("invalid")
        return super().to_internal_value(data)


class LabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Label
        fields = ["id", "name", "color"]

    def validate_color(self, value):
        if not HEX_COLOR.fullmatch(value):
            raise serializers.ValidationError("Color must be a hex color such as #64748b.")
        return value

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
    story_points = StrictIntegerField(min_value=0, max_value=STORY_POINTS_MAX, required=False, allow_null=True)

    class Meta:
        model = Issue
        fields = [
            "id", "key", "number", "project", "project_key", "title", "description", "issue_type", "priority",
            "status", "status_category", "sprint", "parent", "parent_summary", "assignee", "assignee_detail",
            "reporter_detail", "story_points", "due_date", "rank", "labels", "resolved_at", "created_at", "updated_at",
        ]
        read_only_fields = ["key", "number", "rank", "resolved_at", "created_at", "updated_at"]

    def validate_due_date(self, value):
        if value is None:
            return value
        today = timezone.localdate()
        earliest, latest = shift_years(today, -DUE_DATE_YEARS), shift_years(today, DUE_DATE_YEARS)
        if not earliest <= value <= latest:
            raise serializers.ValidationError(f"Due date must be between {earliest} and {latest}.")
        return value

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
            raise serializers.ValidationError({"project": ARCHIVED_MESSAGE})
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

        # Parent/type rules (hierarchy and cycles) run under the project lock: see services.validate_hierarchy.

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

    # SVG, HTML and every other type are not allowed: they can carry active content.
    SIGNATURES = {
        ".png": (b"\x89PNG\r\n\x1a\n",),
        ".jpg": (b"\xff\xd8\xff",),
        ".jpeg": (b"\xff\xd8\xff",),
        ".gif": (b"GIF87a", b"GIF89a"),
        ".pdf": (b"%PDF-",),
        ".zip": (b"PK\x03\x04", b"PK\x05\x06"),  # normal and empty archives
    }
    TEXT_TYPES = {".csv", ".md", ".txt"}

    def validate_file(self, value):
        extension = PurePath(value.name).suffix.lower()
        if extension not in self.ALLOWED_TYPES:
            raise serializers.ValidationError("Unsupported file type. Allowed: CSV, GIF, JPEG, Markdown, PDF, PNG, TXT, WebP, ZIP.")
        if value.size > settings.FILE_UPLOAD_HARD_LIMIT:
            raise serializers.ValidationError(f"Files can be at most {settings.FILE_UPLOAD_HARD_LIMIT // (1024 * 1024)} MB.")
        # The extension and Content-Type both come from the client, so the bytes decide.
        value.seek(0)
        head = value.read(16)
        if extension == ".webp":
            matches = head[:4] == b"RIFF" and head[8:12] == b"WEBP"
        elif extension in self.TEXT_TYPES:
            matches = self._is_utf8_text(value)
        else:
            matches = head.startswith(self.SIGNATURES[extension])
        value.seek(0)
        if not matches:
            raise serializers.ValidationError("The file's contents don't match its extension.")
        # Store the type we verified, never the client's header (octet-stream used to bypass the check).
        value.content_type = sorted(self.ALLOWED_TYPES[extension])[0]
        return value

    @staticmethod
    def _is_utf8_text(value):
        decoder = codecs.getincrementaldecoder("utf-8")()
        value.seek(0)
        try:
            for chunk in value.chunks():
                if b"\x00" in chunk:
                    return False
                decoder.decode(chunk)
            decoder.decode(b"", final=True)
        except UnicodeDecodeError:
            return False
        return True


class AuditLogSerializer(serializers.ModelSerializer):
    actor = UserMiniSerializer(read_only=True)

    class Meta:
        model = AuditLog
        fields = ["id", "entity_type", "entity_label", "project_key", "issue_key", "issue_title", "actor", "action", "changes", "created_at"]
