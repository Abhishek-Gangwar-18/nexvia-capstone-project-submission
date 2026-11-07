import http.client
import ipaddress
import json
import logging
import time
import socket
import ssl
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import timedelta
from email.utils import parsedate_to_datetime
from smtplib import SMTPException

import certifi
from celery import shared_task
from django.conf import settings
from django.db import transaction
from django.db.models import Count, F, Q
from django.utils import timezone

from apps.issues.models import Issue, AuditLog, IssueComment
from apps.tenants.models import Invitation, Membership

from .emails import absolute_url, send_templated_email
from .models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport
from .queue import enqueue
from .reports import BUILDERS, ReportError
from .signing import sign

logger = logging.getLogger(__name__)


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


def _pinned_handlers(ip, sockets=None):
    """Connect to the IP that was validated instead of resolving the hostname again, so a DNS
    answer that changes after the check (DNS rebinding) can't redirect the request internally."""

    class PinnedHTTP(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.create_connection((ip, self.port), self.timeout)
            if sockets is not None:
                sockets.append(self.sock)

    class PinnedHTTPS(http.client.HTTPSConnection):
        def connect(self):
            raw = socket.create_connection((ip, self.port), self.timeout)
            if sockets is not None:
                sockets.append(raw)  # closing the raw socket also unblocks a TLS read on top of it
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


DELIVERY_TIMEOUT = 8  # seconds, per socket operation (connect, each read)
# Hard cap on a whole attempt. Per-operation timeouts alone let a receiver that trickles one byte every
# few seconds hold an attempt open for hours. Must stay well below LEASE, so a slow attempt can never be
# reclaimed by another worker while its original worker is still running.
DELIVERY_DEADLINE = 20  # seconds
RESPONSE_BODY_LIMIT = 4096  # bytes kept from the receiver's response
LEASE = timedelta(seconds=60)  # > DELIVERY_DEADLINE plus bookkeeping; an expired lease may be reclaimed
MAX_RETRY_DELAY = 3600  # seconds, also caps Retry-After


class _Retry(Exception):
    def __init__(self, message, delay=None):
        super().__init__(message)
        self.delay = delay


class _Fail(Exception):
    """A response that retrying can't fix (4xx other than 429, redirects, blocked targets)."""


def _retry_after(value):
    """Retry-After as delta-seconds or an HTTP-date, clamped to [1, MAX_RETRY_DELAY]. None if unusable."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        seconds = int(value)
    else:
        try:
            seconds = (parsedate_to_datetime(value) - timezone.now()).total_seconds()
        except (TypeError, ValueError, IndexError, OverflowError):
            return None
    return int(min(max(seconds, 1), MAX_RETRY_DELAY))


def claim_delivery(delivery_id):
    """Claim the row for this worker and commit, so the HTTP call happens outside any transaction.
    skip_locked: a second worker that races here gets nothing instead of waiting and re-sending."""
    now = timezone.now()
    with transaction.atomic():
        delivery = (
            WebhookDelivery.objects.select_for_update(skip_locked=True, of=("self",)).select_related("endpoint")
            .filter(pk=delivery_id)
            .filter(Q(state=WebhookDelivery.State.PENDING) | Q(state=WebhookDelivery.State.PROCESSING, lease_expires_at__lt=now))
            .first()
        )
        if delivery is None:
            return None
        delivery.state = WebhookDelivery.State.PROCESSING
        delivery.claimed_at, delivery.lease_expires_at = now, now + LEASE
        delivery.claim_token = uuid.uuid4().hex
        delivery.save(update_fields=["state", "claimed_at", "lease_expires_at", "claim_token", "updated_at"])
    return delivery


def _send(endpoint, delivery):
    """One attempt. Returns (status, body) on 2xx; raises _Retry or _Fail otherwise. The same SSRF rules
    apply to test sends, real events and redeliveries: HTTPS only (outside DEBUG), every resolved address
    must be public, the connection is pinned to the checked IP, redirects are refused, short timeouts."""
    try:
        target_ip = _safe_target(endpoint.url)
    except BlockedTarget as exc:
        raise _Fail(str(exc))
    except OSError as exc:  # DNS lookup failed: transient, so retry (never leave the row PROCESSING)
        raise _Retry(f"Could not resolve the webhook host: {exc}")
    body = json.dumps({
        "id": str(delivery.event_id), "event": delivery.event,
        "created_at": delivery.created_at.isoformat(), "data": delivery.payload,
    }, separators=(",", ":")).encode()
    timestamp = int(time.time())  # fresh per attempt; event id and payload stay the same across retries
    request = urllib.request.Request(endpoint.url, data=body, method="POST", headers={
        "Content-Type": "application/json", "User-Agent": "FlowBoard-Webhooks/2.0",
        "X-FlowBoard-Event": delivery.event, "X-FlowBoard-Delivery": str(delivery.event_id),
        "X-FlowBoard-Timestamp": str(timestamp), "X-FlowBoard-Signature": sign(endpoint.secret, timestamp, body),
    })
    sockets = []
    # An empty ProxyHandler stops proxy environment variables from bypassing the pinned connection.
    opener = urllib.request.build_opener(
        _NoRedirect, urllib.request.ProxyHandler({}), *_pinned_handlers(target_ip, sockets)
    )
    try:
        return _within_deadline(lambda: _exchange(opener, request), sockets)
    except urllib.error.HTTPError as exc:
        delivery.response_status = exc.code
        delivery.response_body = exc.read(RESPONSE_BODY_LIMIT).decode("utf-8", "replace")
        if exc.code == 429:
            raise _Retry("Webhook responded with HTTP 429.", _retry_after(exc.headers.get("Retry-After")))
        if exc.code >= 500:
            raise _Retry(f"Webhook responded with HTTP {exc.code}.")
        raise _Fail(f"Webhook responded with HTTP {exc.code}.")  # 3xx (redirects refused) and other 4xx
    except (urllib.error.URLError, OSError) as exc:  # DNS, refused, reset, TLS and timeouts
        raise _Retry(f"Network error: {getattr(exc, 'reason', exc)}")


def _exchange(opener, request):
    with opener.open(request, timeout=DELIVERY_TIMEOUT) as response:
        return response.status, response.read(RESPONSE_BODY_LIMIT).decode("utf-8", "replace")


def _within_deadline(call, sockets):
    """Run the HTTP exchange in a helper thread; past DELIVERY_DEADLINE, close its sockets (which makes the
    blocked read fail) and treat the attempt as a timeout. Exceptions from the exchange are re-raised here."""
    outcome = {}

    def run():
        try:
            outcome["value"] = call()
        except BaseException as exc:  # noqa: BLE001 - handed back to the caller below
            outcome["error"] = exc

    worker = threading.Thread(target=run, daemon=True, name="webhook-attempt")
    worker.start()
    worker.join(DELIVERY_DEADLINE)
    if worker.is_alive():
        for sock in sockets:
            try:
                sock.close()
            except OSError:
                pass
        worker.join(2)
        raise _Retry(f"Webhook took longer than {DELIVERY_DEADLINE} seconds.")
    if "error" in outcome:
        raise outcome["error"]
    return outcome["value"]


def _record_final_failure(delivery, message):
    delivery.state, delivery.last_error = WebhookDelivery.State.FAILED, message[:2000]
    delivery.next_attempt_at = delivery.lease_expires_at = None
    delivery.save()
    endpoint = delivery.endpoint
    WebhookEndpoint.objects.filter(pk=endpoint.pk).update(consecutive_failures=F("consecutive_failures") + 1)
    limit = settings.WEBHOOK_AUTO_DISABLE_AFTER
    # Conditional update: only the call that flips is_active writes the audit event, so it happens once.
    flipped = WebhookEndpoint.objects.filter(pk=endpoint.pk, is_active=True, consecutive_failures__gte=limit).update(
        is_active=False, disabled_at=timezone.now(), disabled_reason=f"Disabled after {limit} failed deliveries in a row.",
    )
    if flipped:
        from apps.issues.activity import record_event

        record_event(endpoint.workspace, None, AuditLog.Action.UPDATED, AuditLog.Entity.WEBHOOK, endpoint.name,
                     changes={"is_active": {"from": True, "to": False}, "reason": f"{limit} consecutive failed deliveries"})


@shared_task(bind=True, max_retries=5, name="apps.automation.tasks.deliver_webhook")
def deliver_webhook(self, delivery_id):
    delivery = claim_delivery(delivery_id)
    if delivery is None:
        return  # already delivered, failed, or being handled by another worker
    endpoint = delivery.endpoint
    if not endpoint.is_active:
        delivery.state, delivery.last_error = WebhookDelivery.State.FAILED, "Webhook endpoint is disabled."
        delivery.lease_expires_at = None
        delivery.save()
        return
    delivery.attempts += 1
    try:
        status, response_body = _send(endpoint, delivery)
    except _Fail as exc:
        _record_final_failure(delivery, str(exc))
        return
    except _Retry as exc:
        if self.request.retries >= self.max_retries:
            _record_final_failure(delivery, str(exc))
            return
        delay = exc.delay or min(2 ** (self.request.retries + 1), MAX_RETRY_DELAY)
        delivery.state, delivery.last_error = WebhookDelivery.State.PENDING, str(exc)[:2000]
        delivery.next_attempt_at, delivery.lease_expires_at = timezone.now() + timedelta(seconds=delay), None
        delivery.save()
        raise self.retry(exc=exc, countdown=delay)
    delivery.state, delivery.response_status, delivery.response_body = WebhookDelivery.State.DELIVERED, status, response_body
    delivery.last_error, delivery.delivered_at = "", timezone.now()
    delivery.next_attempt_at = delivery.lease_expires_at = None
    delivery.save()
    WebhookEndpoint.objects.filter(pk=endpoint.pk).update(consecutive_failures=0)


@shared_task(name="apps.automation.tasks.recover_stalled_deliveries")
def recover_stalled_deliveries():
    """A worker that died after claiming leaves a PROCESSING row; once its lease expires, queue it again."""
    stalled = WebhookDelivery.objects.filter(
        state=WebhookDelivery.State.PROCESSING, lease_expires_at__lt=timezone.now()
    ).values_list("pk", flat=True)[:500]
    for pk in stalled:
        enqueue(deliver_webhook, pk)
    return len(stalled)


@shared_task(name="apps.automation.tasks.process_issue_event")
def process_issue_event(audit_id):
    audit = AuditLog.objects.select_related("workspace", "project", "actor").filter(pk=audit_id).first()
    if audit is None or audit.entity_type != AuditLog.Entity.ISSUE:
        return
    event = f"issue.{audit.action}"
    payload = {
        "issue": {"key": audit.issue_key, "title": audit.issue_title, "project": audit.project_key},
        # No email: the URL may belong to any third party. The id is stable for correlating users.
        "actor": {"id": audit.actor_id, "display_name": audit.actor.display_name if audit.actor_id else None},
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
    # One grouped query for every workspace, then memberships are matched in memory (was one COUNT each).
    counts = dict(
        AuditLog.objects.filter(created_at__gte=since).order_by()
        .values_list("workspace_id").annotate(n=Count("id"))
    )
    for membership in Membership.objects.select_related("workspace", "user").iterator():
        count = counts.get(membership.workspace_id, 0)  # zero-activity workspaces are counted, not dropped
        if count:  # ...but nobody gets a daily "0 updates" message
            notify(
                membership.workspace, membership.user_id, f"digest:{today.isoformat()}", email=True,
                title=f"{membership.workspace.name} daily digest",
                body=f"{count} updates in your workspace over the last day.",
                url=f"/w/{membership.workspace.slug}/dashboard",
            )
    return counts


REPORT_FAILED_MESSAGE = "Report generation failed. Try again."


@shared_task(name="apps.automation.tasks.generate_workspace_report")
def generate_workspace_report(report_id):
    report = WorkspaceReport.objects.select_related("workspace", "project", "sprint").filter(pk=report_id).first()
    if not report or report.state != WorkspaceReport.State.PENDING:
        return
    try:
        result = {"data": BUILDERS[report.report_type](report), "state": WorkspaceReport.State.READY, "error": ""}
    except ReportError as exc:  # expected and safe to show, e.g. "The sprint for this report was deleted."
        result = {"state": WorkspaceReport.State.FAILED, "error": str(exc)[:500]}
    except Exception:
        # Full details go to the server log only; users see a generic message.
        logger.exception("Report %s (%s) failed", report.pk, report.report_type)
        result = {"state": WorkspaceReport.State.FAILED, "error": REPORT_FAILED_MESSAGE}
    # Conditional write: if this run was declared lost (stale after 15 min) and the report marked failed,
    # a late finish changes nothing. Replacements are separate rows, so they can't be touched either.
    written = WorkspaceReport.objects.filter(pk=report.pk, state=WorkspaceReport.State.PENDING).update(
        updated_at=timezone.now(), **result
    )
    if not written:
        logger.info("Report %s finished after it was superseded; result discarded", report.pk)


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


@shared_task(name="apps.automation.tasks.send_password_reset_email", **EMAIL_RETRY)
def send_password_reset_email(user_id):
    from django.contrib.auth.tokens import default_token_generator
    from django.utils.encoding import force_bytes
    from django.utils.http import urlsafe_base64_encode

    from apps.accounts.models import User

    user = User.objects.filter(pk=user_id, is_active=True).first()
    if user is None:
        return
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = default_token_generator.make_token(user)
    send_templated_email("Reset your FlowBoard password", "password_reset", {
        "name": user.display_name,
        "url": absolute_url(f"/reset-password/{uid}/{token}"),
        "minutes": settings.PASSWORD_RESET_TIMEOUT // 60,
    }, user.email)


@shared_task(name="apps.automation.tasks.purge_expired_invitations")
def purge_expired_invitations():
    """Delete unaccepted invitations that expired more than INVITATION_RETENTION_DAYS ago. Accepted ones stay."""
    cutoff = timezone.now() - timedelta(days=settings.INVITATION_RETENTION_DAYS)
    deleted, _ = Invitation.objects.filter(accepted_at__isnull=True, expires_at__lt=cutoff).delete()
    return deleted


PURGE_BATCH = 1000


def _stripe_events():
    from apps.billing.models import StripeEvent  # billing imports automation at module level

    return StripeEvent.objects.all()


def _purge(queryset):
    """Delete in small batches so no single transaction runs long. Idempotent: re-running deletes nothing new."""
    total = 0
    while True:
        ids = list(queryset.values_list("pk", flat=True)[:PURGE_BATCH])
        if not ids:
            return total
        deleted, _ = queryset.model.objects.filter(pk__in=ids).delete()
        total += len(ids)


@shared_task(name="apps.automation.tasks.purge_old_records")
def purge_old_records():
    """Nightly retention. Rows still being worked on (pending/processing deliveries, pending reports) are kept.
    Reports are stored as JSON in the database, so there are no files to clean up."""
    now = timezone.now()
    days = settings.RETENTION_DAYS
    counts = {
        "webhook_deliveries": _purge(WebhookDelivery.objects.filter(
            created_at__lt=now - timedelta(days=days["webhook_deliveries"]),
            state__in=[WebhookDelivery.State.DELIVERED, WebhookDelivery.State.FAILED],
        )),
        "read_notifications": _purge(Notification.objects.filter(
            read_at__isnull=False, created_at__lt=now - timedelta(days=days["read_notifications"]))),
        "unread_notifications": _purge(Notification.objects.filter(
            read_at__isnull=True, created_at__lt=now - timedelta(days=days["unread_notifications"]))),
        "reports": _purge(WorkspaceReport.objects.filter(
            created_at__lt=now - timedelta(days=days["reports"]),
        ).exclude(state=WorkspaceReport.State.PENDING)),
        # Ignored event types are kept too: useful when debugging unexpected Stripe behaviour.
        "stripe_events": _purge(_stripe_events().filter(created_at__lt=now - timedelta(days=days["stripe_events"]))),
    }
    logger.info("Retention purge: %s", counts)
    return counts
