import re

from django.db import transaction
from rest_framework import exceptions

from .models import Board, Project, Sprint, Workflow, WorkflowStatus

Category = WorkflowStatus.Category

ARCHIVED_MESSAGE = "Restore the project first."


# ----------------------------------------------------------------------------- locking convention
#
# The project row is the serialization point for everything inside a project:
#   * workflow replacement, sprint start/complete   -> lock_project(exclusive=True)   (FOR UPDATE)
#   * issue create / update / move                  -> lock_project()                 (FOR NO KEY UPDATE)
# FOR UPDATE conflicts with FOR NO KEY UPDATE, so an issue can't be moved into a status while the
# workflow that owns it is being replaced. Issue numbering's UPDATE also takes FOR NO KEY UPDATE.
# Always lock the project before any sprint, workflow or issue row to keep a single lock order.

def lock_project(project_id, *, exclusive=False):
    """Must be called inside transaction.atomic()."""
    queryset = Project.objects.filter(pk=project_id)
    queryset = queryset.select_for_update() if exclusive else queryset.select_for_update(no_key=True)
    return queryset.get()


def assert_project_writable(project):
    """Archived projects are read-only, except for restoring or deleting them."""
    if project.is_archived:
        raise exceptions.ValidationError({"project": [ARCHIVED_MESSAGE]})


def assert_sprint_deletable(sprint):
    """Only planned sprints may be deleted: active ones are in use, closed ones are velocity history."""
    assert_project_writable(sprint.project)
    if sprint.state == Sprint.State.ACTIVE:
        raise exceptions.ValidationError("Complete the sprint before deleting it.")
    if sprint.state == Sprint.State.CLOSED:
        raise exceptions.ValidationError("Completed sprints are kept for velocity and reports and can't be deleted.")


def next_sprint_name(project):
    """'<KEY> Sprint <n>' with n = highest existing number + 1, so numbering never goes backwards."""
    pattern = re.compile(rf"^{re.escape(project.key)} Sprint (\d+)$")
    numbers = [int(m.group(1)) for name in project.sprints.values_list("name", flat=True) if (m := pattern.match(name))]
    return f"{project.key} Sprint {max(numbers, default=0) + 1}"


def prune_wip_limits(project):
    """Drop WIP limits whose status no longer exists in the project's workflow."""
    valid = {str(pk) for pk in project.workflow.statuses.values_list("pk", flat=True)}
    for board in project.boards.all():
        kept = {key: value for key, value in board.wip_limits.items() if key in valid}
        if kept != board.wip_limits:
            board.wip_limits = kept
            board.save(update_fields=["wip_limits", "updated_at"])

DEFAULT_STATUSES = [
    ("To Do", Category.TODO, "#64748b"),
    ("In Progress", Category.IN_PROGRESS, "#3b82f6"),
    ("In Review", Category.IN_PROGRESS, "#a855f7"),
    ("Done", Category.DONE, "#22c55e"),
]


@transaction.atomic
def create_project(
    *, workspace, name, key, created_by=None, lead=None, description="", color="#6366f1",
    board_type=Board.BoardType.SCRUM,
):
    """Create a project together with its default workflow and board."""
    project = Project.objects.create(
        workspace=workspace, name=name, key=key.upper(), description=description,
        color=color, lead=lead, created_by=created_by,
    )
    workflow = Workflow.objects.create(project=project, name=f"{project.key} workflow")
    for position, (status_name, category, status_color) in enumerate(DEFAULT_STATUSES):
        WorkflowStatus.objects.create(
            workflow=workflow, name=status_name, category=category, color=status_color, position=position,
        )
    Board.objects.create(project=project, name=f"{project.key} board", board_type=board_type)
    return project
