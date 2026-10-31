from django.contrib import admin

from .models import Issue, Label


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
