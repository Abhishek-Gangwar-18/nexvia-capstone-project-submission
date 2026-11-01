import hashlib
import hmac
import ipaddress
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.db.models import Count, Q
from django.utils import timezone

from apps.issues.models import Issue, IssueAuditLog
from apps.tenants.models import Membership

from .models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport


def _safe_target(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ({"https", "http"} if settings.DEBUG else {"https"}) or not parsed.hostname:
        raise ValueError("Webhook target must use HTTPS (HTTP is allowed only in DEBUG).")
    addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    for address in addresses:
        ip = address[4][0]
        if not settings.DEBUG and not ipaddress.ip_address(ip).is_global:
            raise ValueError("Webhook targets must resolve to a public IP address.")
    return parsed


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


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
        _safe_target(endpoint.url)
        body = json.dumps({"id": str(delivery.event_id), "event": delivery.event, "created_at": delivery.created_at.isoformat(), "data": delivery.payload}, separators=(",", ":")).encode()
        signature = hmac.new(endpoint.secret.encode(), body, hashlib.sha256).hexdigest()
        request = urllib.request.Request(endpoint.url, data=body, headers={
            "Content-Type": "application/json", "User-Agent": "FlowBoard-Webhooks/1.0",
            "X-FlowBoard-Event": delivery.event, "X-FlowBoard-Delivery": str(delivery.event_id),
            "X-FlowBoard-Signature": f"sha256={signature}",
        }, method="POST")
        opener = urllib.request.build_opener(_NoRedirect)
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
    audit = IssueAuditLog.objects.select_related("project", "actor").filter(pk=audit_id).first()
    if audit is None:
        return
    event = f"issue.{audit.action}"
    payload = {
        "issue": {"key": audit.issue_key, "title": audit.issue_title, "project": audit.project.key},
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
            deliver_webhook.delay(delivery.pk)
    recipient_ids = set()
    issue = Issue.objects.filter(project_id=audit.project_id, key=audit.issue_key).first()
    if issue and issue.assignee_id and issue.assignee_id != audit.actor_id:
        recipient_ids.add(issue.assignee_id)
    comment_id = audit.changes.get("comment_id")
    if comment_id:
        from apps.issues.models import IssueComment
        comment = IssueComment.objects.filter(pk=comment_id).first()
        if comment:
            recipient_ids.update(comment.mentions.exclude(pk=audit.actor_id).values_list("pk", flat=True))
    for recipient_id in recipient_ids:
        Notification.objects.get_or_create(
            workspace=audit.workspace, recipient_id=recipient_id, event_key=f"audit:{audit.pk}",
            defaults={"actor": audit.actor, "title": f"Update on {audit.issue_key}",
                      "body": f"{audit.actor.display_name if audit.actor_id else 'A teammate'} updated {audit.issue_title}",
                      "url": f"/w/{audit.workspace.slug}/projects/{audit.project.key}/board?issue={audit.issue_key}"},
        )


@shared_task(name="apps.automation.tasks.create_overdue_reminders")
def create_overdue_reminders():
    today = timezone.localdate()
    for issue in Issue.objects.filter(due_date__lt=today).exclude(status__category="done").exclude(assignee=None).select_related("workspace", "assignee", "project"):
        Notification.objects.get_or_create(
            workspace=issue.workspace, recipient=issue.assignee,
            event_key=f"overdue:{issue.pk}:{today.isoformat()}",
            defaults={"title": f"Overdue: {issue.key}", "body": issue.title,
                      "url": f"/w/{issue.workspace.slug}/projects/{issue.project.key}/board?issue={issue.key}"},
        )


@shared_task(name="apps.automation.tasks.create_daily_digests")
def create_daily_digests():
    today = timezone.localdate()
    since = timezone.now() - timedelta(days=1)
    for membership in Membership.objects.select_related("workspace", "user").all().iterator():
        count = IssueAuditLog.objects.filter(workspace=membership.workspace, created_at__gte=since).count()
        if count:
            Notification.objects.get_or_create(
                workspace=membership.workspace, recipient=membership.user, event_key=f"digest:{today.isoformat()}",
                defaults={"title": f"{membership.workspace.name} daily digest",
                          "body": f"{count} issue updates in your workspace over the last day.",
                          "url": f"/w/{membership.workspace.slug}/dashboard/"},
            )


@shared_task(name="apps.automation.tasks.generate_workspace_report")
def generate_workspace_report(report_id):
    report = WorkspaceReport.objects.select_related("workspace").filter(pk=report_id).first()
    if not report:
        return
    try:
        issues = Issue.objects.for_workspace(report.workspace)
        report.data = {
            "generated_at": timezone.now().isoformat(),
            "issue_count": issues.count(),
            "by_status": list(issues.values("status__name").annotate(count=Count("id")).order_by("status__name")),
            "by_priority": list(issues.values("priority").annotate(count=Count("id")).order_by("priority")),
            "projects": list(issues.values("project__key", "project__name").annotate(count=Count("id")).order_by("project__key")),
        }
        report.state = WorkspaceReport.State.READY
        report.save(update_fields=["data", "state", "updated_at"])
    except Exception as exc:
        report.state = WorkspaceReport.State.FAILED
        report.error = str(exc)[:500]
        report.save(update_fields=["state", "error", "updated_at"])
