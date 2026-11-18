from django.contrib import admin

from .models import Board, Project, Sprint, Workflow, WorkflowStatus


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ["key", "name", "workspace", "lead", "issue_counter", "is_archived"]
    list_filter = ["workspace", "is_archived"]
    search_fields = ["key", "name"]
    list_select_related = ["workspace", "lead"]

    def has_add_permission(self, request):
        # A project needs its workflow, default statuses and board (create_project); a bare admin-created row
        # is rejected by the DB at commit (projects migration 0007). Projects are created in the app.
        return False


class WorkflowStatusInline(admin.TabularInline):
    model = WorkflowStatus
    extra = 0
    fields = ["name", "category", "color", "position"]


@admin.register(Workflow)
class WorkflowAdmin(admin.ModelAdmin):
    list_display = ["name", "project", "workspace", "enforce_transitions"]
    list_filter = ["workspace"]
    # No transitions inline: the workflow editor is the only write path, so its rules (#13: at least one
    # transition when enforced, no isolated status) can't be bypassed here.
    inlines = [WorkflowStatusInline]

    # A workflow lives and dies with its project (DB-enforced, projects migration 0007): editable, never added
    # or deleted on its own.
    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Board)
class BoardAdmin(admin.ModelAdmin):
    list_display = ["name", "project", "board_type", "workspace"]
    list_filter = ["workspace", "board_type"]

    # A board is created with its project (create_project) and deleted with it; edit only.
    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Sprint)
class SprintAdmin(admin.ModelAdmin):
    list_display = ["name", "project", "state", "start_date", "end_date", "workspace"]
    list_filter = ["workspace", "state"]
    search_fields = ["name", "project__key"]
