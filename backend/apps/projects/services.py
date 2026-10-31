from django.db import transaction

from .models import Board, Project, Workflow, WorkflowStatus

Category = WorkflowStatus.Category

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
