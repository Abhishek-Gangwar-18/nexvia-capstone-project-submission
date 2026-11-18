import re

from django.db import transaction

from apps.automation.queue import enqueue
from apps.tenants.models import Membership

from .models import AuditLog

MENTION_RE = re.compile(r"(?<![\w.+-])@([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})")


def record_issue_event(issue, actor, action, changes=None):
    audit = AuditLog.objects.create(
        workspace_id=issue.workspace_id,
        entity_type=AuditLog.Entity.ISSUE,
        project=issue.project,
        issue_key=issue.key,
        issue_title=issue.title,
        actor=actor,
        action=action,
        changes=changes or {},
    )
    from apps.automation.tasks import process_issue_event  # tasks imports issues.models

    transaction.on_commit(lambda: enqueue(process_issue_event, audit.pk))
    return audit


def record_event(workspace, actor, action, entity_type, label, *, project=None, project_key="", changes=None):
    """Audit a change to something other than an issue. These don't fire webhooks or notifications."""
    return AuditLog.objects.create(
        workspace=workspace, actor=actor, action=action, entity_type=entity_type, entity_label=str(label)[:255],
        project=project, project_key=project_key, changes=changes or {},
    )


def field_changes(instance, before, fields):
    """{field: {from, to}} for fields whose value differs from the `before` snapshot."""
    return {
        field: {"from": before[field], "to": getattr(instance, field)}
        for field in fields
        if before[field] != getattr(instance, field)
    }


def mentioned_members(workspace, body):
    emails = {email.lower() for email in MENTION_RE.findall(body)}
    if not emails:
        return []
    # Deactivated users are never notified, and exact matching uses the unique email index (stored lowercase).
    return [m.user for m in Membership.objects.filter(
        workspace=workspace, user__email__in=emails, user__is_active=True).select_related("user")]
