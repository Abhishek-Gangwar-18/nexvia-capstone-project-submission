import hashlib
import hmac
import http.client
import ipaddress
import json
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import timedelta
from smtplib import SMTPException

import certifi
from celery import shared_task
from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from apps.issues.models import Issue, AuditLog, IssueComment
from apps.tenants.models import Invitation, Membership

from .emails import absolute_url, send_templated_email
from .models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport
from .queue import enqueue
from .reports import BUILDERS


class BlockedTarget(ValueError):
    """The URL is not allowed as a webhook target. Retrying can't help."""


def _safe_target(url):
    """Validate the target and return the IP to connect to."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ({"https", "http"} if settings.DEBUG else {"https"}) or not parsed.hostname:
        raise BlockedTarget("Webhook target must use HTTPS (HTTP is allowed only in DEBUG).")
    addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    for address in addresses:
        ip = address[4][0]
        if not settings.DEBUG and not ipaddress.ip_address(ip).is_global:
            raise BlockedTarget("Webhook targets must resolve to a public IP address.")
    return addresses[0][4][0]


def _pinned_handlers(ip):
    """Connect to the IP that was validated instead of resolving the hostname again, so a DNS
    answer that changes after the check (DNS rebinding) can't redirect the request internally."""

    class PinnedHTTP(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.create_connection((ip, self.port), self.timeout)

    class PinnedHTTPS(http.client.HTTPSConnection):
        def connect(self):
            raw = socket.create_connection((ip, self.port), self.timeout)
            # certifi: the OS trust store on Windows often lacks roots that Python can't fetch on demand.
            context = ssl.create_default_context(cafile=certifi.where())
            self.sock = context.wrap_socket(raw, server_hostname=self.host)

    class HTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(PinnedHTTP, req)

    class HTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(PinnedHTTPS, req)

    return HTTPHandler(), HTTPSHandler()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def notify(workspace, recipient_id, event_key, *, title, body, url="", actor=None, email=False):
    """Create an in-app notification once per event, and email it if it's important enough."""
    item, created = Notification.objects.get_or_create(
        workspace=workspace, recipient_id=recipient_id, event_key=event_key,
        defaults={"actor": actor, "title": title, "body": body[:500], "url": url},
    )
    if created and email:
        enqueue(send_notification_email, item.pk)
    return item


@shared_task(bind=True, max_retries=5, name="apps.automation.tasks.deliver_webhook")
def deliver_webhook(self, delivery_id):
    delivery = WebhookDelivery.objects.select_related("endpoint").filter(pk=delivery_id).first()
    if delivery is None or delivery.state == WebhookDelivery.State.DELIVERED:
        return
    endpoint = delivery.endpoint
    if not endpoint.is_active:
        delivery.state = WebhookDelivery.State.FAILED
        delivery.last_error = "Webhook endpoint is disabled."
        delivery.save(update_fields=["state", "last_error", "updated_at"])
        return
    try:
        target_ip = _safe_target(endpoint.url)
        body = json.dumps({"id": str(delivery.event_id), "event": delivery.event, "created_at": delivery.created_at.isoformat(), "data": delivery.payload}, separators=(",", ":")).encode()
        signature = hmac.new(endpoint.secret.encode(), body, hashlib.sha256).hexdigest()
        request = urllib.request.Request(endpoint.url, data=body, headers={
            "Content-Type": "application/json", "User-Agent": "FlowBoard-Webhooks/1.0",
            "X-FlowBoard-Event": delivery.event, "X-FlowBoard-Delivery": str(delivery.event_id),
            "X-FlowBoard-Signature": f"sha256={signature}",
        }, method="POST")
        # An empty ProxyHandler stops proxy environment variables from bypassing the pinned connection.
        opener = urllib.request.build_opener(
            _NoRedirect, urllib.request.ProxyHandler({}), *_pinned_handlers(target_ip)
        )
        with opener.open(request, timeout=8) as response:
            response_body = response.read(4096).decode("utf-8", "replace")
            status = response.status
        if not 200 <= status < 300:
            delivery.response_status = status
            delivery.response_body = response_body
            raise RuntimeError(f"Webhook responded with HTTP {status}.")
        delivery.attempts += 1
        delivery.response_status = status
        delivery.response_body = response_body
        delivery.state = WebhookDelivery.State.DELIVERED
        delivery.last_error = ""
        delivery.delivered_at = timezone.now()
        delivery.next_attempt_at = None
        delivery.save()
    except BlockedTarget as exc:
        delivery.attempts += 1
        delivery.state = WebhookDelivery.State.FAILED
        delivery.last_error = str(exc)[:2000]
        delivery.next_attempt_at = None
        delivery.save()
    except Exception as exc:
        delivery.attempts += 1
        delivery.last_error = str(exc)[:2000]
        delivery.response_status = getattr(exc, "code", delivery.response_status)
        if isinstance(exc, urllib.error.HTTPError):
            delivery.response_body = exc.read(4096).decode("utf-8", "replace")
        if self.request.retries >= self.max_retries:
            delivery.state = WebhookDelivery.State.FAILED
            delivery.next_attempt_at = None
            delivery.save()
            return
        delay = min(2 ** (self.request.retries + 1), 300)
        delivery.state = WebhookDelivery.State.PENDING
        delivery.next_attempt_at = timezone.now() + timedelta(seconds=delay)
        delivery.save()
        raise self.retry(exc=exc, countdown=delay)


@shared_task(name="apps.automation.tasks.process_issue_event")
def process_issue_event(audit_id):
    audit = AuditLog.objects.select_related("workspace", "project", "actor").filter(pk=audit_id).first()
    if audit is None or audit.entity_type != AuditLog.Entity.ISSUE:
        return
    event = f"issue.{audit.action}"
    payload = {
        "issue": {"key": audit.issue_key, "title": audit.issue_title, "project": audit.project_key},
        "actor": {"id": audit.actor_id, "email": audit.actor.email if audit.actor_id else None},
        "changes": audit.changes,
        "occurred_at": audit.created_at.isoformat(),
    }
    endpoints = WebhookEndpoint.objects.for_workspace(audit.workspace).filter(is_active=True).filter(Q(events__contains=[event]) | Q(events__contains=["*"]))
    for endpoint in endpoints:
        delivery, created = WebhookDelivery.objects.get_or_create(
            workspace=audit.workspace, endpoint=endpoint, event_id=uuid.uuid5(uuid.NAMESPACE_URL, f"flowboard:{audit.pk}:{endpoint.pk}"),
            defaults={"event": event, "payload": payload},
        )
        if created:
            enqueue(deliver_webhook, delivery.pk)
    actor_name = audit.actor.display_name if audit.actor_id else "A teammate"
    verbs = {
        AuditLog.Action.CREATED: "created", AuditLog.Action.MOVED: "moved",
        AuditLog.Action.COMMENTED: "commented on", AuditLog.Action.ATTACHED: "added a file to",
        AuditLog.Action.DETACHED: "removed a file from", AuditLog.Action.DELETED: "deleted",
    }
    bodies = {}
    emailed = set()  # mentions and new assignments deserve an email; routine updates stay in-app
    issue = Issue.objects.filter(project_id=audit.project_id, key=audit.issue_key).first()
    comment_changed = audit.changes.get("edited") or audit.changes.get("deleted")
    if issue and issue.assignee_id and issue.assignee_id != audit.actor_id and not comment_changed:
        newly_assigned = audit.action == AuditLog.Action.CREATED or "assignee" in audit.changes
        if newly_assigned:
            bodies[issue.assignee_id] = f"{actor_name} assigned you {audit.issue_title}"
            emailed.add(issue.assignee_id)
        else:
            bodies[issue.assignee_id] = f"{actor_name} {verbs.get(audit.action, 'updated')} {audit.issue_title}"
    comment_id = audit.changes.get("comment_id")
    if comment_id and not audit.changes.get("deleted"):
        comment = IssueComment.objects.filter(pk=comment_id).first()
        if comment:
            mentions = comment.mentions.exclude(pk=audit.actor_id)
            if audit.changes.get("edited"):  # people already mentioned were told the first time
                mentions = mentions.filter(pk__in=audit.changes.get("new_mentions", []))
            for user_id in mentions.values_list("pk", flat=True):
                bodies[user_id] = f"{actor_name} mentioned you on {audit.issue_title}"
                emailed.add(user_id)
    # Anyone who left the workspace between the event and this task no longer gets notified.
    members = set(Membership.objects.filter(workspace=audit.workspace, user_id__in=bodies).values_list("user_id", flat=True))
    actor = audit.actor if audit.actor_id in Membership.objects.filter(workspace=audit.workspace).values_list("user_id", flat=True) else None
    for recipient_id in members:
        notify(
            audit.workspace, recipient_id, f"audit:{audit.pk}", actor=actor, email=recipient_id in emailed,
            title=f"Update on {audit.issue_key}", body=bodies[recipient_id],
            url=f"/w/{audit.workspace.slug}/projects/{audit.project_key}/board?issue={audit.issue_key}",
        )


@shared_task(name="apps.automation.tasks.create_overdue_reminders")
def create_overdue_reminders():
    today = timezone.localdate()
    for issue in Issue.objects.filter(due_date__lt=today, project__is_archived=False).exclude(status__category="done").exclude(assignee=None).select_related("workspace", "assignee", "project"):
        notify(
            issue.workspace, issue.assignee_id, f"overdue:{issue.pk}:{today.isoformat()}", email=True,
            title=f"Overdue: {issue.key}", body=issue.title,
            url=f"/w/{issue.workspace.slug}/projects/{issue.project.key}/board?issue={issue.key}",
        )


@shared_task(name="apps.automation.tasks.create_daily_digests")
def create_daily_digests():
    today = timezone.localdate()
    since = timezone.now() - timedelta(days=1)
    for membership in Membership.objects.select_related("workspace", "user").all().iterator():
        count = AuditLog.objects.filter(workspace=membership.workspace, created_at__gte=since).count()
        if count:
            notify(
                membership.workspace, membership.user_id, f"digest:{today.isoformat()}", email=True,
                title=f"{membership.workspace.name} daily digest",
                body=f"{count} updates in your workspace over the last day.",
                url=f"/w/{membership.workspace.slug}/dashboard",
            )


@shared_task(name="apps.automation.tasks.generate_workspace_report")
def generate_workspace_report(report_id):
    report = WorkspaceReport.objects.select_related("workspace", "project", "sprint").filter(pk=report_id).first()
    if not report:
        return
    try:
        report.data = BUILDERS[report.report_type](report)
        report.state = WorkspaceReport.State.READY
        report.error = ""
        report.save(update_fields=["data", "state", "error", "updated_at"])
    except Exception as exc:
        report.state = WorkspaceReport.State.FAILED
        report.error = str(exc)[:500]
        report.save(update_fields=["state", "error", "updated_at"])


EMAIL_RETRY = {"autoretry_for": (OSError, SMTPException), "retry_backoff": True, "max_retries": 3}


@shared_task(name="apps.automation.tasks.send_notification_email", **EMAIL_RETRY)
def send_notification_email(notification_id):
    item = Notification.objects.select_related("workspace", "recipient").filter(pk=notification_id).first()
    if item is None or item.emailed_at or not item.recipient.email_notifications:
        return
    send_templated_email(item.title, "notification", {
        "title": item.title, "body": item.body, "workspace": item.workspace.name,
        "url": absolute_url(item.url) if item.url else "",
    }, item.recipient.email)
    item.emailed_at = timezone.now()
    item.save(update_fields=["emailed_at", "updated_at"])


@shared_task(name="apps.automation.tasks.send_invitation_email", **EMAIL_RETRY)
def send_invitation_email(invitation_id):
    invitation = Invitation.objects.select_related("workspace", "invited_by").filter(pk=invitation_id).first()
    if invitation is None or not invitation.is_pending:
        return
    inviter = invitation.invited_by.display_name if invitation.invited_by else "A teammate"
    send_templated_email(f"{inviter} invited you to {invitation.workspace.name} on FlowBoard", "invitation", {
        "workspace": invitation.workspace.name, "inviter": inviter, "role": invitation.get_role_display().lower(),
        "expires_at": invitation.expires_at, "url": invitation.accept_url,
    }, invitation.email)
    invitation.email_sent_at = timezone.now()
    invitation.save(update_fields=["email_sent_at", "updated_at"])
