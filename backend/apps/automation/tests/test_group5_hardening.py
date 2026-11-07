"""Group 5 hardening: webhook secrets, signing, SSRF, throttles, retries, leases, redelivery, retention,
digest, report dedupe/errors, pagination, payload privacy and tenant isolation."""
import io
import threading
import time
import uuid
from datetime import timedelta
from email.message import Message
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

import pytest
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.automation import signing
from apps.automation.models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport
from apps.automation.tasks import (
    _retry_after, claim_delivery, create_daily_digests, deliver_webhook, generate_workspace_report,
    process_issue_event, purge_old_records, recover_stalled_deliveries,
)
from apps.issues.models import AuditLog, Issue
from apps.projects.models import Sprint
from apps.tenants.models import Membership, Workspace

Role = Membership.Role
State = WebhookDelivery.State


@pytest.fixture
def team(tenant_a, make_user, add_member):
    users = {"owner": tenant_a["owner"]}
    users[Role.MEMBER] = make_user("member@g5.test")
    add_member(tenant_a["workspace"], users[Role.MEMBER], Role.MEMBER)
    return {**tenant_a, "users": users}


def owner(api, team):
    return api(team["owner"], team["workspace"])


def endpoint_for(team, **extra):
    return WebhookEndpoint.objects.create(workspace=team["workspace"], name="hook", url="https://hooks.example.test/x",
                                          events=["*"], **extra)


def delivery_for(endpoint, **extra):
    return WebhookDelivery.objects.create(workspace=endpoint.workspace, endpoint=endpoint, event_id=uuid.uuid4(),
                                          event="issue.created", payload={"n": 1}, **extra)


def fake_http(monkeypatch, *, status=200, error=None, capture=None):
    """Replace the network: _safe_target passes, the opener returns `status` or raises `error`."""
    monkeypatch.setattr("apps.automation.tasks._safe_target", lambda _url: "203.0.113.7")

    def open_(request, timeout=None):
        if capture is not None:
            capture.append(request)
        if error is not None:
            raise error() if callable(error) else error
        response = MagicMock(status=status)
        response.read.return_value = b"ok"
        response.__enter__.return_value = response
        return response

    monkeypatch.setattr("apps.automation.tasks.urllib.request.build_opener", lambda *a: MagicMock(open=open_))


def http_error(code, retry_after=None):
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return lambda: HTTPError("https://hooks.example.test/x", code, "err", headers, io.BytesIO(b"nope"))


# ------------------------------------------------------------------------ 1. secret

@pytest.mark.django_db
class TestSecret:
    def test_full_secret_only_on_create_and_rotate(self, api, team):
        client = owner(api, team)
        created = client.post("/api/webhooks/", {"name": "h", "url": "https://hooks.example.test/x", "events": ["*"]},
                              format="json").data
        endpoint = WebhookEndpoint.objects.get(pk=created["id"])
        assert created["secret"] == endpoint.secret and created["secret_hint"].endswith(endpoint.secret[-4:])
        for res in (client.get("/api/webhooks/").data[0], client.get(f"/api/webhooks/{endpoint.pk}/").data,
                    client.patch(f"/api/webhooks/{endpoint.pk}/", {"name": "h2"}, format="json").data):
            assert "secret" not in res and res["secret_hint"].startswith("••••")
        rotated = client.post(f"/api/webhooks/{endpoint.pk}/rotate-secret/").data["secret"]
        endpoint.refresh_from_db()
        assert rotated == endpoint.secret != created["secret"]
        for entry in AuditLog.objects.filter(entity_type=AuditLog.Entity.WEBHOOK):
            assert endpoint.secret not in str(entry.changes) and created["secret"] not in str(entry.changes)


# ------------------------------------------------------------------ 2. signatures

class TestSignature:
    def test_valid_accepted_expired_and_tampered_rejected(self):
        body, now = b'{"a":1}', 1_700_000_000
        sig = signing.sign("s3cret", now, body)
        assert signing.verify("s3cret", str(now), body, sig, now=now + 299)
        assert not signing.verify("s3cret", str(now), body, sig, now=now + 301)  # replayed too late
        assert not signing.verify("s3cret", str(now), body + b" ", sig, now=now)
        assert not signing.verify("wrong", str(now), body, sig, now=now)
        assert not signing.verify("s3cret", "not-a-number", body, sig, now=now)

    @pytest.mark.django_db
    def test_each_attempt_is_freshly_signed_with_a_stable_event_id(self, team, monkeypatch):
        endpoint = endpoint_for(team)
        delivery = delivery_for(endpoint)
        sent = []
        fake_http(monkeypatch, error=http_error(503), capture=sent)
        times = iter([1_700_000_000 + i for i in range(10)])
        monkeypatch.setattr("apps.automation.tasks.time.time", lambda: next(times))
        deliver_webhook.apply(args=(delivery.pk,))
        assert len(sent) == 6
        assert {r.get_header("X-flowboard-delivery") for r in sent} == {str(delivery.event_id)}
        stamps = [r.get_header("X-flowboard-timestamp") for r in sent]
        assert len(set(stamps)) == 6
        for request in sent:
            assert signing.verify(endpoint.secret, request.get_header("X-flowboard-timestamp"), request.data,
                                  request.get_header("X-flowboard-signature"),
                                  now=int(request.get_header("X-flowboard-timestamp")))


# ----------------------------------------------------------------- 3. SSRF + throttle

@pytest.mark.django_db
class TestOutboundSafety:
    @pytest.mark.parametrize("url", ["https://127.0.0.1/x", "https://10.1.2.3/x", "https://localhost/x",
                                     "https://169.254.169.254/x", "http://hooks.example.test/x"])
    def test_create_rejects_unsafe_urls(self, api, team, settings, url):
        settings.DEBUG = False
        res = owner(api, team).post("/api/webhooks/", {"name": "h", "url": url, "events": []}, format="json")
        assert res.status_code == 400

    def test_redirect_is_refused_not_followed(self, team, monkeypatch):
        endpoint = endpoint_for(team)
        delivery = delivery_for(endpoint)
        sent = []
        fake_http(monkeypatch, error=http_error(302), capture=sent)
        deliver_webhook.apply(args=(delivery.pk,))
        delivery.refresh_from_db()
        assert delivery.state == State.FAILED and len(sent) == 1  # one try, no retry, no follow

    def test_sixth_test_request_is_throttled(self, api, team, monkeypatch):
        monkeypatch.setattr("apps.automation.views.deliver_webhook.delay", MagicMock())
        endpoint = endpoint_for(team)
        client = owner(api, team)
        codes = [client.post(f"/api/webhooks/{endpoint.pk}/test/").status_code for _ in range(6)]
        assert codes == [202] * 5 + [429]

    def test_per_user_limit_spans_endpoints(self, api, team, monkeypatch):
        monkeypatch.setattr("apps.automation.views.deliver_webhook.delay", MagicMock())
        endpoints = [endpoint_for(team) for _ in range(3)]
        client = owner(api, team)
        codes = [client.post(f"/api/webhooks/{endpoints[i % 3].pk}/test/").status_code for i in range(11)]
        assert codes[:10] == [202] * 10 and codes[10] == 429

    def test_disabled_endpoint_cannot_be_tested(self, api, team):
        endpoint = endpoint_for(team, is_active=False)
        assert owner(api, team).post(f"/api/webhooks/{endpoint.pk}/test/").status_code == 400


# ------------------------------------------------------------------ 4. endpoint cap

@pytest.mark.django_db
class TestEndpointCap:
    def test_eleventh_is_rejected_under_workspace_lock(self, api, team, settings):
        settings.MAX_WEBHOOKS_PER_WORKSPACE = 10
        for _ in range(10):
            endpoint_for(team)
        client = owner(api, team)
        with CaptureQueriesContext(connection) as queries:
            res = client.post("/api/webhooks/", {"name": "h", "url": "https://hooks.example.test/y", "events": []},
                              format="json")
        assert res.status_code == 400
        assert any("FOR UPDATE" in q["sql"] and "tenants_workspace" in q["sql"] for q in queries.captured_queries)


@pytest.mark.django_db(transaction=True)
def test_concurrent_creates_respect_the_cap(api, tenant_a, settings):
    settings.MAX_WEBHOOKS_PER_WORKSPACE = 1
    results = []

    def create():
        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(tenant_a["owner"])
        client.credentials(HTTP_X_WORKSPACE=tenant_a["workspace"].slug)
        results.append(client.post("/api/webhooks/", {"name": "h", "url": "https://hooks.example.test/c",
                                                      "events": []}, format="json").status_code)
        connection.close()

    threads = [threading.Thread(target=create) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == [201, 400, 400, 400]
    assert WebhookEndpoint.objects.filter(workspace=tenant_a["workspace"]).count() == 1


# ---------------------------------------------------------------- 5. report errors

@pytest.mark.django_db
class TestReportErrors:
    def test_raw_exception_never_exposed(self, api, team):
        report = WorkspaceReport.objects.create(workspace=team["workspace"], requested_by=team["owner"])
        with patch.dict("apps.automation.tasks.BUILDERS",
                        {report.report_type: MagicMock(side_effect=RuntimeError("relation secret_table at /srv/app.py"))}):
            generate_workspace_report(report.pk)
        report.refresh_from_db()
        assert report.state == "failed" and report.error == "Report generation failed. Try again."
        body = str(owner(api, team).get(f"/api/reports/{report.pk}/").data)
        assert "secret_table" not in body and "/srv" not in body


# -------------------------------------------------------------- 6. retry policy

@pytest.mark.django_db
class TestRetryPolicy:
    @pytest.mark.parametrize("error, attempts, final", [
        (http_error(400), 1, State.FAILED), (http_error(404), 1, State.FAILED), (http_error(410), 1, State.FAILED),
        (http_error(500), 6, State.FAILED), (http_error(429, "1"), 6, State.FAILED),
        (lambda: OSError("connection reset"), 6, State.FAILED),
    ])
    def test_classification(self, team, monkeypatch, error, attempts, final):
        delivery = delivery_for(endpoint_for(team))
        fake_http(monkeypatch, error=error)
        deliver_webhook.apply(args=(delivery.pk,))
        delivery.refresh_from_db()
        assert (delivery.state, delivery.attempts) == (final, attempts)

    def test_success_resets_consecutive_failures(self, team, monkeypatch):
        endpoint = endpoint_for(team, consecutive_failures=7)
        fake_http(monkeypatch, status=200)
        deliver_webhook.apply(args=(delivery_for(endpoint).pk,))
        endpoint.refresh_from_db()
        assert endpoint.consecutive_failures == 0

    def test_retry_after_parsing(self):
        assert _retry_after("30") == 30
        assert _retry_after("999999") == 3600  # capped
        future = (timezone.now() + timedelta(seconds=120)).strftime("%a, %d %b %Y %H:%M:%S GMT")
        assert 100 <= _retry_after(future) <= 120
        assert _retry_after("garbage") is None and _retry_after(None) is None

    def test_429_uses_retry_after_as_countdown(self, team, monkeypatch):
        delivery = delivery_for(endpoint_for(team))
        fake_http(monkeypatch, error=http_error(429, "42"))
        retry = MagicMock(side_effect=RuntimeError("stop"))
        monkeypatch.setattr(deliver_webhook, "retry", retry)
        with pytest.raises(RuntimeError):
            deliver_webhook.run(delivery.pk)
        assert retry.call_args.kwargs["countdown"] == 42
        delivery.refresh_from_db()
        assert delivery.state == State.PENDING and delivery.lease_expires_at is None

    def test_auto_disable_once_after_20_failures(self, team, monkeypatch, settings):
        settings.WEBHOOK_AUTO_DISABLE_AFTER = 20
        endpoint = endpoint_for(team)
        fake_http(monkeypatch, error=http_error(400))
        for _ in range(20):
            deliver_webhook.apply(args=(delivery_for(endpoint).pk,))
        endpoint.refresh_from_db()
        assert not endpoint.is_active and endpoint.disabled_at and endpoint.consecutive_failures == 20
        disabled_events = AuditLog.objects.filter(entity_type=AuditLog.Entity.WEBHOOK, changes__is_active__to=False)
        assert disabled_events.count() == 1
        deliver_webhook.apply(args=(delivery_for(endpoint).pk,))  # later deliveries: no new audit event
        assert disabled_events.count() == 1


# -------------------------------------------------------- 7. claiming and leases

@pytest.mark.django_db
class TestClaims:
    def test_second_claim_gets_nothing(self, team):
        delivery = delivery_for(endpoint_for(team))
        assert claim_delivery(delivery.pk) is not None
        assert claim_delivery(delivery.pk) is None  # PROCESSING with a live lease
        delivery.refresh_from_db()
        assert delivery.state == State.PROCESSING and delivery.claim_token

    def test_expired_lease_can_be_reclaimed_and_is_swept(self, team, monkeypatch):
        delivery = delivery_for(endpoint_for(team), state=State.PROCESSING,
                                lease_expires_at=timezone.now() - timedelta(seconds=1))
        queued = MagicMock(return_value=None)
        monkeypatch.setattr("apps.automation.tasks.enqueue", queued)
        assert recover_stalled_deliveries() == 1
        assert queued.call_args.args[1] == delivery.pk
        assert claim_delivery(delivery.pk) is not None

    def test_finished_rows_are_never_reclaimed(self, team):
        delivery = delivery_for(endpoint_for(team), state=State.DELIVERED)
        assert claim_delivery(delivery.pk) is None


@pytest.mark.django_db(transaction=True)
def test_locked_row_is_skipped_by_another_worker(tenant_a):
    endpoint = WebhookEndpoint.objects.create(workspace=tenant_a["workspace"], name="h",
                                              url="https://hooks.example.test/x", events=["*"])
    delivery = delivery_for(endpoint)
    locked, release = threading.Event(), threading.Event()

    def first_worker():
        with transaction.atomic():
            WebhookDelivery.objects.select_for_update().get(pk=delivery.pk)
            locked.set()
            release.wait(5)
        connection.close()

    thread = threading.Thread(target=first_worker)
    thread.start()
    locked.wait(5)
    try:
        assert claim_delivery(delivery.pk) is None  # skip_locked: no wait, no double send
    finally:
        release.set()
        thread.join()


# ---------------------------------------------------------------- 8. redelivery

@pytest.mark.django_db
class TestRedelivery:
    def test_rules(self, api, team, tenant_b, monkeypatch):
        monkeypatch.setattr("apps.automation.views.deliver_webhook.delay", MagicMock())
        endpoint = endpoint_for(team)
        failed = delivery_for(endpoint, state=State.FAILED)
        delivered = delivery_for(endpoint, state=State.DELIVERED)
        client = owner(api, team)
        url = f"/api/webhooks/{endpoint.pk}/deliveries/{{}}/redeliver/"
        assert client.post(url.format(delivered.pk)).status_code == 400
        res = client.post(url.format(failed.pk))
        assert res.status_code == 202 and res.data["redelivery_of"] == failed.pk
        copy = WebhookDelivery.objects.get(pk=res.data["id"])
        assert (copy.event_id, copy.payload) == (failed.event_id, failed.payload)
        failed.refresh_from_db()
        assert failed.state == State.FAILED  # history kept
        member = api(team["users"][Role.MEMBER], team["workspace"])
        assert member.post(url.format(failed.pk)).status_code == 403
        other = endpoint_for(team)
        assert client.post(f"/api/webhooks/{other.pk}/deliveries/{failed.pk}/redeliver/").status_code == 404

    def test_disabled_endpoint_blocks_redelivery(self, api, team):
        endpoint = endpoint_for(team, is_active=False)
        failed = delivery_for(endpoint, state=State.FAILED)
        res = owner(api, team).post(f"/api/webhooks/{endpoint.pk}/deliveries/{failed.pk}/redeliver/")
        assert res.status_code == 400

    def test_throttled(self, api, team, monkeypatch):
        monkeypatch.setattr("apps.automation.views.deliver_webhook.delay", MagicMock())
        endpoint = endpoint_for(team)
        failed = delivery_for(endpoint, state=State.FAILED)
        client = owner(api, team)
        codes = [client.post(f"/api/webhooks/{endpoint.pk}/deliveries/{failed.pk}/redeliver/").status_code
                 for _ in range(6)]
        assert codes == [202] * 5 + [429]


# ----------------------------------------------------------------- 9. retention

@pytest.mark.django_db
class TestRetention:
    def test_purge(self, team):
        old = timezone.now() - timedelta(days=200)
        endpoint = endpoint_for(team)
        rows = {
            "old_delivered": delivery_for(endpoint, state=State.DELIVERED),
            "old_processing": delivery_for(endpoint, state=State.PROCESSING),
            "old_pending": delivery_for(endpoint, state=State.PENDING),
            "new_failed": delivery_for(endpoint, state=State.FAILED),
        }
        for key in ("old_delivered", "old_processing", "old_pending"):
            WebhookDelivery.objects.filter(pk=rows[key].pk).update(created_at=old)
        member = team["users"][Role.MEMBER]
        read_old = Notification.objects.create(workspace=team["workspace"], recipient=member, event_key="a",
                                               title="t", body="b", read_at=timezone.now())
        unread_mid = Notification.objects.create(workspace=team["workspace"], recipient=member, event_key="b",
                                                 title="t", body="b")
        Notification.objects.filter(pk=read_old.pk).update(created_at=timezone.now() - timedelta(days=91))
        Notification.objects.filter(pk=unread_mid.pk).update(created_at=timezone.now() - timedelta(days=91))
        ready = WorkspaceReport.objects.create(workspace=team["workspace"], state="ready")
        pending = WorkspaceReport.objects.create(workspace=team["workspace"], state="pending")
        WorkspaceReport.objects.filter(pk__in=[ready.pk, pending.pk]).update(created_at=old)

        counts = purge_old_records()
        assert counts == {"webhook_deliveries": 1, "read_notifications": 1, "unread_notifications": 0, "reports": 1,
                          "stripe_events": 0}
        assert set(WebhookDelivery.objects.values_list("pk", flat=True)) == {
            rows["old_processing"].pk, rows["old_pending"].pk, rows["new_failed"].pk}
        assert Notification.objects.filter(pk=unread_mid.pk).exists()
        assert WorkspaceReport.objects.filter(pk=pending.pk).exists()
        assert purge_old_records() == {k: 0 for k in counts}  # idempotent


# --------------------------------------------------------------------- 10. digest

@pytest.mark.django_db
def test_digest_is_one_grouped_query(team, tenant_b, monkeypatch):
    monkeypatch.setattr("apps.automation.tasks.enqueue", MagicMock(return_value=None))
    AuditLog.objects.filter(workspace=tenant_b["workspace"]).delete()  # make Globex a zero-activity workspace
    Issue.objects.create(project=team["project"], title="activity")
    AuditLog.objects.create(workspace=team["workspace"], action="created", entity_type="issue", actor=team["owner"])
    with CaptureQueriesContext(connection) as queries:
        counts = create_daily_digests()
    audit_queries = [q for q in queries.captured_queries if "issues_auditlog" in q["sql"]]
    assert len(audit_queries) == 1
    assert counts.get(tenant_b["workspace"].pk, 0) == 0
    assert Notification.objects.filter(workspace=team["workspace"], event_key__startswith="digest:").count() == 2
    assert not Notification.objects.filter(workspace=tenant_b["workspace"], event_key__startswith="digest:").exists()


# -------------------------------------------------------------- 11. report dedupe

@pytest.mark.django_db
class TestReportDedupe:
    def test_identical_pending_is_reused(self, api, team, monkeypatch):
        delay = MagicMock()
        monkeypatch.setattr("apps.automation.views.generate_workspace_report.delay", delay)
        client = owner(api, team)
        first = client.post("/api/reports/", {"report_type": "workspace_summary"}, format="json")
        second = client.post("/api/reports/", {"report_type": "workspace_summary"}, format="json")
        assert (first.status_code, second.status_code) == (202, 200)
        assert first.data["id"] == second.data["id"] and delay.call_count == 1

    def test_finished_or_stale_reports_do_not_block(self, api, team, monkeypatch):
        monkeypatch.setattr("apps.automation.views.generate_workspace_report.delay", MagicMock())
        client = owner(api, team)
        first = client.post("/api/reports/", {"report_type": "workspace_summary"}, format="json").data
        WorkspaceReport.objects.filter(pk=first["id"]).update(state="ready")
        second = client.post("/api/reports/", {"report_type": "workspace_summary"}, format="json")
        assert second.status_code == 202
        WorkspaceReport.objects.filter(pk=second.data["id"]).update(created_at=timezone.now() - timedelta(hours=1))
        third = client.post("/api/reports/", {"report_type": "workspace_summary"}, format="json")
        assert third.status_code == 202 and third.data["id"] != second.data["id"]
        assert WorkspaceReport.objects.get(pk=second.data["id"]).state == "failed"

    def test_db_allows_one_pending_identical_report(self, team):
        WorkspaceReport.objects.create(workspace=team["workspace"])
        with pytest.raises(IntegrityError), transaction.atomic():
            WorkspaceReport.objects.create(workspace=team["workspace"])  # NULL project/sprint still collide

    def test_throttled(self, api, team, monkeypatch):
        monkeypatch.setattr("apps.automation.views.generate_workspace_report.delay", MagicMock())
        client = owner(api, team)
        codes = []
        for _ in range(11):
            codes.append(client.post("/api/reports/", {"report_type": "workspace_summary"}, format="json").status_code)
            WorkspaceReport.objects.update(state="ready")
        assert codes[:10] == [202] * 10 and codes[10] == 429


@pytest.mark.django_db(transaction=True)
def test_concurrent_identical_reports_queue_one_job(tenant_a, monkeypatch):
    delay = MagicMock()
    monkeypatch.setattr("apps.automation.views.generate_workspace_report.delay", delay)
    codes = []

    def request():
        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(tenant_a["owner"])
        client.credentials(HTTP_X_WORKSPACE=tenant_a["workspace"].slug)
        codes.append(client.post("/api/reports/", {"report_type": "workspace_summary"}, format="json").status_code)
        connection.close()

    threads = [threading.Thread(target=request) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes) == [200, 200, 200, 202] and delay.call_count == 1


# ---------------------------------------------------------------- 12. pagination

@pytest.mark.django_db
class TestPagination:
    def test_notifications(self, api, team):
        member = team["users"][Role.MEMBER]
        now = timezone.now()
        for i in range(5):
            n = Notification.objects.create(workspace=team["workspace"], recipient=member, event_key=f"k{i}",
                                            title=f"t{i}", body="b", read_at=now if i < 2 else None)
            Notification.objects.filter(pk=n.pk).update(created_at=now)  # identical timestamps: id breaks ties
        client = api(member, team["workspace"])
        plain = client.get("/api/notifications/").data
        assert set(plain) == {"unread_count", "results"} and plain["unread_count"] == 3
        page1 = client.get("/api/notifications/?page=1&page_size=2").data
        page2 = client.get("/api/notifications/?page=2&page_size=2").data
        assert page1["unread_count"] == 3 and page1["count"] == 5
        ids = [n["id"] for n in page1["results"] + page2["results"]]
        assert ids == sorted(ids, reverse=True) and len(set(ids)) == 4
        assert len(client.get("/api/notifications/?page=1&page_size=9999").data["results"]) == 5

    def test_deliveries_and_reports(self, api, team):
        endpoint = endpoint_for(team)
        for _ in range(3):
            delivery_for(endpoint, state=State.DELIVERED)
        client = owner(api, team)
        assert len(client.get(f"/api/webhooks/{endpoint.pk}/deliveries/").data) == 3
        assert client.get(f"/api/webhooks/{endpoint.pk}/deliveries/?page=1&page_size=2").data["count"] == 3
        WorkspaceReport.objects.create(workspace=team["workspace"], state="ready")
        assert isinstance(client.get("/api/reports/").data, list)
        assert client.get("/api/reports/?page=1").data["count"] == 1


# -------------------------------------------------------------- 13 and 14. API

@pytest.mark.django_db
class TestApiPolish:
    def test_put_is_gone(self, api, team):
        endpoint = endpoint_for(team)
        res = owner(api, team).put(f"/api/webhooks/{endpoint.pk}/",
                                   {"name": "x", "url": "https://hooks.example.test/x", "events": []}, format="json")
        assert res.status_code == 405

    def test_payload_has_no_actor_email(self, team, monkeypatch):
        monkeypatch.setattr("apps.automation.tasks.enqueue", MagicMock(return_value=None))
        endpoint = endpoint_for(team)
        issue = Issue.objects.create(project=team["project"], title="private")
        audit = AuditLog.objects.create(workspace=team["workspace"], entity_type="issue", action="created",
                                        project=team["project"], issue_key=issue.key, issue_title=issue.title,
                                        actor=team["owner"])
        process_issue_event(audit.pk)
        payload = WebhookDelivery.objects.get(endpoint=endpoint).payload
        assert payload["actor"] == {"id": team["owner"].pk, "display_name": team["owner"].display_name}
        assert team["owner"].email not in str(payload)


# ---------------------------------------------------------- tenant isolation

@pytest.mark.django_db
def test_foreign_webhook_and_delivery_ids_are_404(api, team, tenant_b, monkeypatch):
    monkeypatch.setattr("apps.automation.views.deliver_webhook.delay", MagicMock())
    foreign = WebhookEndpoint.objects.create(workspace=tenant_b["workspace"], name="theirs",
                                             url="https://hooks.example.test/x", events=["*"])
    foreign_delivery = delivery_for(foreign, state=State.FAILED)
    mine = endpoint_for(team)
    client = owner(api, team)
    for method, url in [
        ("get", f"/api/webhooks/{foreign.pk}/"), ("get", f"/api/webhooks/{foreign.pk}/deliveries/"),
        ("post", f"/api/webhooks/{foreign.pk}/test/"), ("post", f"/api/webhooks/{foreign.pk}/rotate-secret/"),
        ("delete", f"/api/webhooks/{foreign.pk}/"),
        ("post", f"/api/webhooks/{foreign.pk}/deliveries/{foreign_delivery.pk}/redeliver/"),
        ("post", f"/api/webhooks/{mine.pk}/deliveries/{foreign_delivery.pk}/redeliver/"),
    ]:
        assert getattr(client, method)(url).status_code == 404, url
    assert WebhookEndpoint.objects.filter(pk=foreign.pk).exists()


# ------------------------------------------------- follow-ups: deadline and stale reports

def test_lease_outlasts_the_longest_attempt():
    from apps.automation import tasks
    assert tasks.LEASE.total_seconds() >= tasks.DELIVERY_DEADLINE * 2


@pytest.mark.django_db
def test_trickling_receiver_hits_the_total_deadline(team, monkeypatch, settings):
    """Each byte arrives inside the per-read timeout, so only the total deadline can stop this."""
    import socket as socketlib
    from apps.automation import tasks

    settings.DEBUG = True  # plain-HTTP loopback receiver
    server = socketlib.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    stop = threading.Event()

    def trickle():
        conn, _ = server.accept()
        conn.recv(65536)
        try:
            for byte in b"HTTP/1.1 200 OK\r\nX-Slow: " + b"a" * 1000:
                if stop.is_set():
                    break
                conn.sendall(bytes([byte]))
                time.sleep(0.2)
        except OSError:
            pass
        finally:
            conn.close()

    thread = threading.Thread(target=trickle, daemon=True)
    thread.start()
    monkeypatch.setattr(tasks, "DELIVERY_DEADLINE", 1)
    monkeypatch.setattr(tasks, "_safe_target", lambda _url: "127.0.0.1")
    endpoint = endpoint_for(team)
    endpoint.url = f"http://127.0.0.1:{port}/hook"
    delivery = delivery_for(endpoint)
    started = time.monotonic()
    try:
        with pytest.raises(tasks._Retry, match="longer than 1 seconds"):
            tasks._send(endpoint, delivery)
    finally:
        stop.set()
        server.close()
    assert time.monotonic() - started < 5


@pytest.mark.django_db
def test_superseded_report_run_cannot_write_its_result(team):
    report = WorkspaceReport.objects.create(workspace=team["workspace"], requested_by=team["owner"])

    def slow_builder(_report):
        # While this run was "lost", the request path declared the report failed.
        WorkspaceReport.objects.filter(pk=report.pk).update(state="failed", error="Report generation failed. Try again.")
        return {"late": True}

    with patch.dict("apps.automation.tasks.BUILDERS", {report.report_type: slow_builder}):
        generate_workspace_report(report.pk)
    report.refresh_from_db()
    assert report.state == "failed" and report.data == {}
