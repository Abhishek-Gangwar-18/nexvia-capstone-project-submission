"""Asynchronous workspace deletion.

Deleting a workspace in the request took 7.85 s for 20k issues in ONE transaction (about 1 ms per issue), so a
workspace of ~150k issues would pass gunicorn's 60 s timeout, roll back, and become impossible to delete. Instead:

1. The request (owner, slug + password confirmed) only marks the row with deleting_at and returns 202. From
   that moment the workspace is invisible (X-Workspace resolution, the workspace list, invitations, webhooks,
   daily jobs) and no new row can be inserted into it (see "In-flight writes" below).
2. After commit a Celery task (purge_workspace) cancels the Stripe subscription, retrying with backoff and
   touching no data until Stripe confirms, then removes the data in batches, each batch in its own short
   transaction, and deletes the workspace row last. Stripe is never called before the mark is durable, so a
   crash can't leave a live workspace whose subscription was already cancelled.
3. A periodic sweep re-queues any deletion that has been pending for a while (a lost enqueue, a crashed worker,
   Stripe retries exhausted). Every step is idempotent, so resuming after a partial run is safe.

Cascade map (all 18 workspace FKs are ON DELETE CASCADE). The high-volume tables are emptied explicitly, in an
order that respects the FKs between them; everything else is small and goes with the final row delete:

  batched, in order                     why first / how
  -----------------------------------   -------------------------------------------------------------------
  issues_issuecomment                   unbounded per issue; plain rows (fast DELETE, no signals)
  issues_issueattachment                ORM delete so post_delete schedules each file's removal after commit
  issues_auditlog                       largest table; no FKs into it
  automation_notification               high volume; no FKs into it
  automation_webhookdelivery            high volume; redelivery_of (self, SET NULL) handled by the collector
  issues_issue                          comments/attachments already gone; label links cascade (<= 20 each);
                                        parent (self, SET NULL) handled by the collector; status is RESTRICT,
                                        so issues must go before the statuses (final step)
  final: tenants_workspace row          cascades the small, bounded rest: memberships, invitations, labels
                                        (<= 500), projects (plan-capped), workflows, statuses, transitions,
                                        boards, sprints, webhook endpoints, reports, subscription

In-flight writes: a BEFORE INSERT trigger on every workspace table (tenants migration 0010) locks the workspace
row FOR KEY SHARE and rejects the insert (SQLSTATE FB001, a 404 in the API) once deleting_at is set. The mark is
taken under FOR UPDATE, which conflicts with that lock, so an insert either commits before the mark (it finished
before deletion began; the purge removes it) or is rejected after it. No write gets a 201 once deletion began.
"""
import logging
from contextlib import contextmanager
from datetime import timedelta

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from .models import Workspace

logger = logging.getLogger(__name__)

LOCK_CLASS = 7302  # pg advisory lock namespace (billing uses 7301)
STALLED_AFTER = timedelta(minutes=10)


def _batched_models():
    from apps.automation.models import Notification, WebhookDelivery
    from apps.issues.models import AuditLog, Issue, IssueAttachment, IssueComment

    return [IssueComment, IssueAttachment, AuditLog, Notification, WebhookDelivery, Issue]


def start_deletion(workspace):
    """Mark the workspace as deleting and queue the purge after commit. Returns False if it already was."""
    from apps.automation.queue import enqueue
    from apps.automation.tasks import delete_workspace

    with transaction.atomic():
        # FOR UPDATE, deliberately the only one on this row: it conflicts with the FOR KEY SHARE that every
        # INSERT into a workspace table takes (trigger, tenants/0010), so the mark waits for inserts already in
        # progress and later inserts see deleting_at. All other workspace locks (plan-limit checks, ownership
        # transfer) use FOR NO KEY UPDATE, which serializes them with each other but not with inserts.
        locked = Workspace.objects.select_for_update().get(pk=workspace.pk)
        if locked.deleting_at is not None:
            return False
        locked.deleting_at = timezone.now()
        locked.save(update_fields=["deleting_at", "updated_at"])
        # If the broker is down, enqueue logs and returns; the stalled-deletion sweep picks it up later.
        transaction.on_commit(lambda: enqueue(delete_workspace, locked.pk))
    logger.info("Workspace %s (%s) marked for deletion", locked.pk, locked.slug)
    return True


@contextmanager
def _exclusive(workspace_id):
    """One purge per workspace at a time (the sweep may queue a duplicate while a long purge is running)."""
    with connection.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s, %s)", [LOCK_CLASS, workspace_id])
        acquired = cur.fetchone()[0]
    try:
        yield acquired
    finally:
        if acquired:
            with connection.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s, %s)", [LOCK_CLASS, workspace_id])


def _delete_in_batches(model, workspace_id, batch_size):
    deleted = 0
    while True:
        # No ORDER BY: rows already deleted are gone, so "any batch" makes progress without sorting the table.
        ids = list(model.objects.filter(workspace_id=workspace_id).order_by().values_list("pk", flat=True)[:batch_size])
        if not ids:
            return deleted
        with transaction.atomic():
            model.objects.filter(pk__in=ids).delete()
        deleted += len(ids)


def purge_workspace(workspace_id, *, batch_size=None):
    """Delete a workspace marked as deleting. Idempotent and resumable. Returns 'deleted', 'busy' or 'gone'.
    Raises BillingUnavailable if Stripe can't confirm the cancellation (the task retries; no data is touched)."""
    from apps.billing.services import cancel_for_deleted_workspace

    batch_size = batch_size or settings.WORKSPACE_DELETE_BATCH
    workspace = Workspace.objects.filter(pk=workspace_id, deleting_at__isnull=False).first()
    if workspace is None:
        return "gone"  # already deleted (or never marked: never delete a live workspace from here)
    with _exclusive(workspace_id) as acquired:
        if not acquired:
            return "busy"
        cancel_for_deleted_workspace(workspace)  # no-op if already cancelled; never delete while still charging
        counts = {}
        for model in _batched_models():
            counts[model._meta.db_table] = _delete_in_batches(model, workspace_id, batch_size)
        with transaction.atomic():
            Workspace.objects.filter(pk=workspace_id, deleting_at__isnull=False).delete()
    logger.info("Workspace %s deleted: %s", workspace_id, counts)
    return "deleted"


def stalled_deletions(now=None):
    now = now or timezone.now()
    return list(Workspace.objects.filter(deleting_at__lte=now - STALLED_AFTER).order_by("deleting_at")
                .values_list("pk", flat=True)[:50])
