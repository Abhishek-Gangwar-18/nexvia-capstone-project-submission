import logging

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.projects.models import Sprint, WorkflowStatus
from apps.projects.services import ARCHIVED_MESSAGE, lock_project

from .models import RANK_STEP, Issue

MIN_RANK_GAP = 1e-6
UNSET = object()
logger = logging.getLogger(__name__)


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
    # Shared project lock (see projects/services.py): a workflow replacement can't delete the status mid-move.
    project = lock_project(issue.project_id)
    if project.is_archived:
        raise ValidationError({"project": ARCHIVED_MESSAGE})
    # Re-read under the lock: the transition check and resolved_at must use the current status, and the save
    # below writes only the moved columns, so a concurrent PATCH of other fields isn't reverted.
    issue.refresh_from_db()
    issue.project = project
    before = (issue.status_id, issue.status.name, issue.sprint_id, issue.sprint.name if issue.sprint_id else None)
    if status is not None and status.pk != issue.status_id:
        if not WorkflowStatus.objects.filter(pk=status.pk).exists():
            raise ValidationError({"status": "This status no longer exists. Reload the board."})
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

    issue.save(update_fields=["status", "sprint", "rank", "resolved_at", "updated_at"])
    return before


# ------------------------------------------------------------------------------------- hierarchy
#
#   Parent              Allowed children
#   epic                story, task, bug
#   story, task, bug    subtask
#   subtask             (none)

T = Issue.IssueType
ALLOWED_CHILDREN = {
    T.EPIC: {T.STORY, T.TASK, T.BUG},
    T.STORY: {T.SUBTASK},
    T.TASK: {T.SUBTASK},
    T.BUG: {T.SUBTASK},
    T.SUBTASK: set(),
}


def validate_hierarchy(*, project, instance, issue_type, parent, parent_changed, type_changed):
    """Run under the project lock (see projects/services.py) so two concurrent edits can't each pass
    the cycle check and form a cycle together. Only re-checked when the parent or the type changes,
    so issues created under the older, looser rules stay editable."""
    from rest_framework import exceptions

    errors = {}
    if parent is not None and (parent_changed or type_changed):
        if parent.project_id != project.pk or parent.workspace_id != project.workspace_id:
            errors["parent"] = "The parent issue belongs to a different project."
        elif instance is not None and parent.pk == instance.pk:
            errors["parent"] = "An issue can't be its own parent."
        elif issue_type not in ALLOWED_CHILDREN[parent.issue_type]:
            allowed = ", ".join(sorted(ALLOWED_CHILDREN[parent.issue_type])) or "nothing"
            kind = parent.get_issue_type_display().lower()
            article = "An" if kind[0] in "aeiou" else "A"
            errors["parent"] = f"{article} {kind} can only contain: {allowed}."
        elif instance is not None:
            # Walk up from the new parent; reaching this issue means the change would close a loop.
            seen, node = set(), parent
            while node is not None and node.pk not in seen:
                if node.pk == instance.pk:
                    errors["parent"] = "This would create a cycle of parent issues."
                    break
                seen.add(node.pk)
                node = Issue.objects.filter(pk=node.parent_id).only("pk", "parent_id").first() if node.parent_id else None
    if instance is not None and type_changed:
        child_types = set(instance.children.values_list("issue_type", flat=True))
        if child_types - ALLOWED_CHILDREN[issue_type]:
            errors["issue_type"] = "This issue has children that a " + dict(T.choices)[issue_type].lower() + " can't contain."
    if errors:
        raise exceptions.ValidationError(errors)


# ------------------------------------------------------------------------- comments and attachments
# Every write here goes through assert_project_writable: archived projects are read-only.

def _writable(issue):
    from apps.projects.services import assert_project_writable

    assert_project_writable(issue.project)


def can_edit_comment(comment, user):
    return comment.author_id == user.pk  # editing someone else's words would be impersonation


def can_delete_comment(comment, membership):
    from apps.tenants.models import Membership

    return comment.author_id == membership.user_id or membership.has_role(Membership.Role.ADMIN)


@transaction.atomic
def add_comment(issue, author, body, mentions):
    from .models import IssueComment

    _writable(issue)
    comment = IssueComment.objects.create(workspace_id=issue.workspace_id, issue=issue, author=author, body=body)
    comment.mentions.set(mentions)
    return comment


@transaction.atomic
def edit_comment(comment, body, mentions):
    """Returns the ids of newly mentioned users; notifications for them go out after commit."""
    _writable(comment.issue)
    comment.body = body
    comment.save(update_fields=["body", "updated_at"])  # author is never touched
    before = set(comment.mentions.values_list("pk", flat=True))
    comment.mentions.set(mentions)
    return sorted(set(comment.mentions.values_list("pk", flat=True)) - before)


@transaction.atomic
def delete_comment(comment):
    _writable(comment.issue)
    comment.delete()


def add_attachment(issue, uploader, uploaded, record):
    """Store the file, then create the row (and audit entry, via `record`) in one transaction.
    Storage writes can't be rolled back, so if the DB part fails the stored file is deleted again.
    Must be called outside any outer transaction (DRF views don't use ATOMIC_REQUESTS here), otherwise
    a later outer rollback would bypass this compensation."""
    from .models import IssueAttachment

    _writable(issue)
    attachment = IssueAttachment(
        workspace_id=issue.workspace_id, issue=issue, uploaded_by=uploader,
        original_name=uploaded.name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1][:255],
        content_type=uploaded.content_type, size=uploaded.size,  # verified by the serializer; DB CHECK backs it
    )
    attachment.file.save(uploaded.name, uploaded, save=False)  # exact storage key now in attachment.file.name
    stored_name, storage = attachment.file.name, attachment.file.storage
    try:
        with transaction.atomic():
            attachment.save()
            record(attachment)
    except BaseException:
        try:
            storage.delete(stored_name)
        except Exception:  # never hide the original error; the orphan sweep removes the file later
            logger.exception("Could not remove stored file %s after a failed upload", stored_name)
        raise
    return attachment


@transaction.atomic
def delete_attachment(attachment):
    _writable(attachment.issue)
    attachment.delete()  # the post_delete signal removes the file after commit


@transaction.atomic
def delete_issue(issue):
    _writable(issue)
    issue.delete()
