from django.contrib import admin

from .models import Board, Project, Sprint, Workflow, WorkflowStatus, WorkflowTransition


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ["key", "name", "workspace", "lead", "issue_counter", "is_archived"]
    list_filter = ["workspace", "is_archived"]
    search_fields = ["key", "name"]
    list_select_related = ["workspace", "lead"]


class WorkflowStatusInline(admin.TabularInline):
    model = WorkflowStatus
    extra = 0
    fields = ["name", "category", "color", "position"]


class WorkflowTransitionInline(admin.TabularInline):
    model = WorkflowTransition
    extra = 0
    fields = ["from_status", "to_status", "name"]


@admin.register(Workflow)
class WorkflowAdmin(admin.ModelAdmin):
    list_display = ["name", "project", "workspace", "enforce_transitions"]
    list_filter = ["workspace"]
    inlines = [WorkflowStatusInline, WorkflowTransitionInline]


@admin.register(Board)
class BoardAdmin(admin.ModelAdmin):
    list_display = ["name", "project", "board_type", "workspace"]
    list_filter = ["workspace", "board_type"]


@admin.register(Sprint)
class SprintAdmin(admin.ModelAdmin):
    list_display = ["name", "project", "state", "start_date", "end_date", "workspace"]
    list_filter = ["workspace", "state"]
    search_fields = ["name", "project__key"]
