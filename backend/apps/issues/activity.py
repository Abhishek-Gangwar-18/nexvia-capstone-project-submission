import re
import logging

from django.db import transaction
from apps.tenants.models import Membership

from .models import IssueAuditLog

MENTION_RE = re.compile(r"(?<![\w.+-])@([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})")
logger = logging.getLogger(__name__)


def record_issue_event(issue, actor, action, changes=None):
    audit = IssueAuditLog.objects.create(
        workspace_id=issue.workspace_id,
        project=issue.project,
        issue_key=issue.key,
        issue_title=issue.title,
        actor=actor,
        action=action,
        changes=changes or {},
    )
    from apps.automation.tasks import process_issue_event
    def enqueue(event_id=audit.pk):
        try:
            process_issue_event.delay(event_id)
        except Exception:
            logger.exception("Could not enqueue issue event %s for background processing", event_id)
    transaction.on_commit(enqueue)
    return audit


def mentioned_members(workspace, body):
    emails = {email.lower() for email in MENTION_RE.findall(body)}
    if not emails:
        return []
    return [m.user for m in Membership.objects.filter(workspace=workspace, user__email__in=emails).select_related("user")]
