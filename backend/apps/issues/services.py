from django.core.exceptions import ValidationError
from django.db import transaction

from apps.projects.models import Sprint

from .models import RANK_STEP, Issue

MIN_RANK_GAP = 1e-6
UNSET = object()


def rebalance_ranks(project_id):
    """Spread ranks evenly again after many inserts between the same two neighbours."""
    issues = list(Issue.objects.filter(project_id=project_id).order_by("rank", "id").only("id", "rank"))
    for index, issue in enumerate(issues, start=1):
        issue.rank = index * RANK_STEP
    Issue.objects.bulk_update(issues, ["rank"], batch_size=500)


def rank_between(prev_rank, next_rank):
    if prev_rank is None and next_rank is None:
        return None
    if prev_rank is None:
        return next_rank - RANK_STEP
    if next_rank is None:
        return prev_rank + RANK_STEP
    return (prev_rank + next_rank) / 2


@transaction.atomic
def move_issue(issue, *, status=None, sprint=UNSET, prev_id=None, next_id=None):
    """Drag-and-drop move: optionally change status/sprint, then slot between two neighbours."""
    if status is not None and status.pk != issue.status_id:
        if status.workflow.project_id != issue.project_id:
            raise ValidationError({"status": "This status belongs to a different project."})
        if not issue.project.workflow.can_transition(issue.status, status):
            raise ValidationError({"status": f"Transition '{issue.status.name}' → '{status.name}' is not allowed."})
        issue.status = status

    if sprint is not UNSET:
        if sprint is not None and sprint.project_id != issue.project_id:
            raise ValidationError({"sprint": "This sprint belongs to a different project."})
        if sprint is not None and sprint.state == Sprint.State.CLOSED:
            raise ValidationError({"sprint": "Issues can't be added to a closed sprint."})
        issue.sprint = sprint

    neighbours = Issue.objects.filter(project_id=issue.project_id).exclude(pk=issue.pk)
    prev = neighbours.filter(pk=prev_id).first() if prev_id else None
    nxt = neighbours.filter(pk=next_id).first() if next_id else None
    if prev and nxt and nxt.rank - prev.rank < MIN_RANK_GAP:
        rebalance_ranks(issue.project_id)
        prev.refresh_from_db(fields=["rank"])
        nxt.refresh_from_db(fields=["rank"])
    new_rank = rank_between(prev.rank if prev else None, nxt.rank if nxt else None)
    if new_rank is not None:
        issue.rank = new_rank

    issue.save()
    return issue
