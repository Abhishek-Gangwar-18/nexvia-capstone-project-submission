from django.contrib import admin

from .models import Issue, IssueAttachment, AuditLog, IssueComment, Label


@admin.register(Label)
class LabelAdmin(admin.ModelAdmin):
    list_display = ["name", "color", "workspace"]
    list_filter = ["workspace"]


@admin.register(Issue)
class IssueAdmin(admin.ModelAdmin):
    list_display = ["key", "title", "issue_type", "priority", "status", "assignee", "sprint", "workspace"]
    list_filter = ["workspace", "issue_type", "priority", "status__category"]
    search_fields = ["key", "title"]
    list_select_related = ["status", "assignee", "sprint", "workspace", "project"]
    readonly_fields = ["key", "number", "resolved_at", "created_at", "updated_at"]
    raw_id_fields = ["parent", "assignee", "reporter", "sprint", "status", "project"]
    filter_horizontal = ["labels"]


@admin.register(IssueComment)
class IssueCommentAdmin(admin.ModelAdmin):
    list_display = ["issue", "author", "workspace", "created_at"]
    list_filter = ["workspace"]
    search_fields = ["issue__key", "body", "author__email"]
    readonly_fields = ["created_at", "updated_at"]


@admin.register(IssueAttachment)
class IssueAttachmentAdmin(admin.ModelAdmin):
    list_display = ["original_name", "issue", "uploaded_by", "size", "workspace", "created_at"]
    list_filter = ["workspace", "content_type"]
    search_fields = ["original_name", "issue__key"]
    readonly_fields = ["created_at", "updated_at"]


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ["entity_type", "entity_label", "action", "actor", "workspace", "created_at"]
    list_filter = ["workspace", "entity_type", "action"]
    search_fields = ["entity_label", "issue_key", "actor__email"]
    readonly_fields = ["created_at", "updated_at", "changes"]
