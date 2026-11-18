"""Reconcile attachment files in storage with the issues_issueattachment table.

Postgres and file storage can't share a transaction, so they can drift apart:
- a file with no row (an orphan): the process died between storing the file and committing the row, a delete
  callback failed after commit, or rows were removed by hand. Orphans are deleted here.
- a row with no file (missing): someone removed files from storage directly. Those rows are only reported,
  never deleted, so a person can investigate (restore from backup or remove the row deliberately).

Safe to re-run: every step re-checks the current state, and nothing younger than the grace period is touched.
"""
import logging
from datetime import timedelta

from django.utils import timezone

from .models import IssueAttachment

logger = logging.getLogger(__name__)

PREFIX = "issues"  # attachment_path() stores everything under issues/YYYY/MM/
GRACE = timedelta(hours=24)  # an upload stores the file a moment before its row commits
BATCH = 500
MAX_FILES = 100_000  # bound one run; the next night continues
MISSING_SAMPLE = 50


def _walk(storage, path):
    try:
        dirs, files = storage.listdir(path)
    except FileNotFoundError:
        return
    for name in files:
        yield f"{path}/{name}"
    for name in dirs:
        yield from _walk(storage, f"{path}/{name}")


def _delete_unreferenced(storage, batch, stats):
    # Checked right before deleting, so a row committed since the file was listed protects it.
    referenced = set(IssueAttachment.objects.filter(file__in=batch).values_list("file", flat=True))
    for name in batch:
        if name in referenced:
            continue
        try:
            storage.delete(name)
            stats["orphans_deleted"] += 1
            logger.info("Attachment sweep: deleted orphan file %s", name)
        except Exception:
            stats["delete_failures"] += 1
            logger.exception("Attachment sweep: could not delete orphan file %s", name)


def sweep_attachment_files(*, storage=None, now=None, grace=GRACE, batch_size=BATCH, max_files=MAX_FILES):
    storage = storage or IssueAttachment._meta.get_field("file").storage
    now = now or timezone.now()
    cutoff = now - grace
    stats = {"files_scanned": 0, "skipped_recent": 0, "orphans_deleted": 0, "delete_failures": 0,
             "missing_files": 0, "missing_sample": [], "complete": True}

    batch = []
    for name in _walk(storage, PREFIX):
        if stats["files_scanned"] >= max_files:
            stats["complete"] = False
            break
        stats["files_scanned"] += 1
        try:
            modified = storage.get_modified_time(name)  # the storage's own timestamp, not the file name
        except (FileNotFoundError, OSError):
            continue  # removed while we were listing
        if modified >= cutoff:
            stats["skipped_recent"] += 1
            continue
        batch.append(name)
        if len(batch) >= batch_size:
            _delete_unreferenced(storage, batch, stats)
            batch = []
    if batch:
        _delete_unreferenced(storage, batch, stats)

    # The other direction: rows whose file is gone. Report only.
    rows = IssueAttachment.objects.filter(created_at__lt=cutoff).values_list("pk", "file").order_by("pk")
    for pk, name in rows.iterator(chunk_size=1000):
        if not storage.exists(name):
            stats["missing_files"] += 1
            if len(stats["missing_sample"]) < MISSING_SAMPLE:
                stats["missing_sample"].append(pk)
    if stats["missing_files"]:
        logger.warning("Attachment sweep: %s attachment rows point at missing files (ids, first %s: %s)",
                       stats["missing_files"], MISSING_SAMPLE, stats["missing_sample"])
    logger.info("Attachment sweep: %s", stats)
    return stats
