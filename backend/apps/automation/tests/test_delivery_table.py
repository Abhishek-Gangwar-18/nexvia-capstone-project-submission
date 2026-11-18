"""Schema review, table #16 (automation_webhookdelivery): redelivery identity independent of retention
(is_redelivery), claim_token fencing on every result write, state CHECKs, and the three index changes."""
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from celery.exceptions import Retry
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.automation import tasks
from apps.automation.models import WebhookDelivery, WebhookEndpoint
from apps.automation.tasks import _finish, claim_delivery, deliver_webhook, purge_old_records
from apps.tenants.deletion import purge_workspace
from apps.tenants.models import Workspace

pytestmark = pytest.mark.django_db


@pytest.fixture
def ep(tenant_a):
    return WebhookEndpoint.objects.create(workspace=tenant_a["workspace"], name="h", url="https://hooks.test/x",
                                          events=["*"])


def delivery(ep, **extra):
    values = {"workspace": ep.workspace, "endpoint": ep, "event_id": uuid.uuid4(), "event": "issue.created",
              "payload": {}}
    values.update(extra)
    return WebhookDelivery.objects.create(**values)


def family(ep, redeliveries=2, state="failed"):
    original = delivery(ep, state=state)
    copies = [delivery(ep, event_id=original.event_id, state=state, redelivery_of=original, is_redelivery=True)
              for _ in range(redeliveries)]
    return original, copies


# ================================================== 1. redelivery identity vs retention

class TestRedeliveryIdentity:
    def test_deleting_the_original_keeps_redeliveries_valid(self, ep):
        original, copies = family(ep)
        original.delete()
        rows = list(WebhookDelivery.objects.filter(pk__in=[c.pk for c in copies]))
        assert len(rows) == 2 and all(r.redelivery_of_id is None and r.is_redelivery for r in rows)

    def test_retention_purge_with_several_redeliveries(self, ep):
        original, copies = family(ep, redeliveries=3)
        old = timezone.now() - timedelta(days=400)
        WebhookDelivery.objects.filter(pk=original.pk).update(created_at=old)
        purge_old_records()  # used to raise IntegrityError
        assert not WebhookDelivery.objects.filter(pk=original.pk).exists()
        assert WebhookDelivery.objects.filter(pk__in=[c.pk for c in copies]).count() == 3
        WebhookDelivery.objects.filter(endpoint=ep).update(created_at=old)
        purge_old_records()
        assert not WebhookDelivery.objects.filter(endpoint=ep).exists()

    def test_workspace_purge_with_redeliveries(self, ep, tenant_a):
        family(ep, redeliveries=3)
        family(ep, redeliveries=2)
        ws_id = tenant_a["workspace"].pk
        Workspace.objects.filter(pk=ws_id).update(deleting_at=timezone.now())
        assert purge_workspace(ws_id, batch_size=1) == "deleted"
        assert not WebhookDelivery.objects.filter(workspace_id=ws_id).exists()

    def test_api_redeliveries_are_flagged(self, api, tenant_a, ep, monkeypatch):
        monkeypatch.setattr("apps.automation.views.enqueue", lambda *a: None)
        original = delivery(ep, state="failed")
        client = api(tenant_a["owner"], tenant_a["workspace"])
        for _ in range(2):
            res = client.post(f"/api/webhooks/{ep.pk}/deliveries/{original.pk}/redeliver/")
            assert res.status_code == 202
        assert WebhookDelivery.objects.filter(redelivery_of=original, is_redelivery=True).count() == 2

    def test_originals_stay_unique(self, ep):
        first = delivery(ep)
        with pytest.raises(IntegrityError), transaction.atomic():
            delivery(ep, event_id=first.event_id)

    def test_pointer_requires_the_flag(self, ep):
        original = delivery(ep, state="failed")
        with pytest.raises(IntegrityError), transaction.atomic():
            delivery(ep, event_id=original.event_id, redelivery_of=original, is_redelivery=False)

    def test_flag_is_immutable(self, ep):
        row = delivery(ep)
        with pytest.raises(DatabaseError) as caught, transaction.atomic():
            WebhookDelivery.objects.filter(pk=row.pk).update(is_redelivery=True)
        assert getattr(caught.value.__cause__, "sqlstate", None) == "FB004"


# ======================================================== 2. fencing on the claim

def steal(row_id, final="delivered"):
    """Another worker reclaims the row after this one's lease expired, and records its own result."""
    WebhookDelivery.objects.filter(pk=row_id).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
    other = claim_delivery(row_id)
    assert other is not None
    other.attempts += 1
    assert _finish(other, state=final, delivered_at=timezone.now() if final == "delivered" else None)
    return other


class TestFencing:
    def test_stale_worker_cannot_overwrite_the_newer_result(self, ep):
        row = delivery(ep)
        a = claim_delivery(row.pk)
        b = steal(row.pk)
        a.attempts += 1
        assert _finish(a, state="pending", last_error="late") is False
        row.refresh_from_db()
        assert (row.state, row.claim_token) == ("delivered", b.claim_token) and row.delivered_at

    def test_stale_success_is_discarded_and_counters_untouched(self, ep):
        row = delivery(ep)
        WebhookEndpoint.objects.filter(pk=ep.pk).update(consecutive_failures=3)
        with patch.object(tasks, "_send", side_effect=lambda e, d: (steal(row.pk, final="failed"), (200, "ok"))[1]):
            deliver_webhook.apply(args=[row.pk])
        row.refresh_from_db()
        assert row.state == "failed"  # the newer worker's result stands
        assert WebhookEndpoint.objects.get(pk=ep.pk).consecutive_failures == 3  # no reset from the stale success

    def test_stale_failure_does_not_count_or_disable(self, ep, settings):
        settings.WEBHOOK_AUTO_DISABLE_AFTER = 1
        row = delivery(ep)

        def lose_then_fail(endpoint, d):
            steal(row.pk)
            raise tasks._Fail("HTTP 410")

        with patch.object(tasks, "_send", side_effect=lose_then_fail):
            deliver_webhook.apply(args=[row.pk])
        ep.refresh_from_db()
        assert ep.consecutive_failures == 0 and ep.is_active
        assert WebhookDelivery.objects.get(pk=row.pk).state == "delivered"

    def test_stale_worker_never_schedules_a_retry(self, ep):
        row = delivery(ep)

        def lose_then_retry(endpoint, d):
            steal(row.pk)
            raise tasks._Retry("HTTP 503")

        with patch.object(tasks, "_send", side_effect=lose_then_retry), \
                patch.object(deliver_webhook, "retry", side_effect=AssertionError("must not retry")):
            deliver_webhook.apply(args=[row.pk]).get()
        assert WebhookDelivery.objects.get(pk=row.pk).state == "delivered"

    def test_disabled_endpoint_path_is_fenced(self, ep):
        row = delivery(ep)
        WebhookEndpoint.objects.filter(pk=ep.pk).update(is_active=False)
        real_claim = tasks.claim_delivery

        def claim_then_lose(pk):
            mine = real_claim(pk)
            steal(pk)
            return mine

        with patch.object(tasks, "claim_delivery", side_effect=claim_then_lose):
            deliver_webhook.apply(args=[row.pk])
        assert WebhookDelivery.objects.get(pk=row.pk).state == "delivered"

    def test_every_result_write_is_fenced(self, ep):
        """No result path may use a full-row save: every UPDATE after the claim carries the claim token."""
        for outcome in ((200, "ok"), tasks._Fail("410"), tasks._Retry("503")):
            row = delivery(ep)
            side = (lambda e, d, o=outcome: o) if isinstance(outcome, tuple) else outcome
            with patch.object(tasks, "_send", side_effect=side), CaptureQueriesContext(connection) as queries, \
                    patch.object(deliver_webhook, "retry", side_effect=Retry()):
                try:
                    deliver_webhook.apply(args=[row.pk])
                except Retry:
                    pass
            writes = [q["sql"] for q in queries.captured_queries
                      if q["sql"].startswith('UPDATE "automation_webhookdelivery"')]
            results = [w for w in writes if '"claim_token" = ' not in w.split("WHERE")[0]]
            assert results and all('"claim_token" =' in w.split("WHERE")[1] for w in results), writes


class TestNormalPaths:
    def test_success_failure_retry(self, ep):
        ok, gone, flaky = delivery(ep), delivery(ep), delivery(ep)
        with patch.object(tasks, "_send", return_value=(200, "ok")):
            deliver_webhook.apply(args=[ok.pk])
        with patch.object(tasks, "_send", side_effect=tasks._Fail("410")):
            deliver_webhook.apply(args=[gone.pk])
        with patch.object(tasks, "_send", side_effect=tasks._Retry("503")), \
                patch.object(deliver_webhook, "retry", side_effect=Retry()), pytest.raises(Retry):
            deliver_webhook.apply(args=[flaky.pk], throw=True)
        ok.refresh_from_db(); gone.refresh_from_db(); flaky.refresh_from_db()
        assert (ok.state, ok.attempts, ok.response_status) == ("delivered", 1, 200) and ok.delivered_at
        assert gone.state == "failed" and gone.lease_expires_at is None
        assert flaky.state == "pending" and flaky.next_attempt_at and flaky.lease_expires_at is None
        assert WebhookEndpoint.objects.get(pk=ep.pk).consecutive_failures == 1


# ================================================================ 3. state CHECKs

@pytest.mark.parametrize("change", [
    {"state": "delivered", "delivered_at": None},
    {"state": "processing", "claimed_at": None, "lease_expires_at": None},
    {"state": "processing", "claimed_at": timezone.now(), "lease_expires_at": None},
    {"state": "failed", "lease_expires_at": timezone.now()},
    {"state": "delivered", "delivered_at": timezone.now(), "lease_expires_at": timezone.now()},
])
def test_state_checks(ep, change):
    row = delivery(ep)
    with pytest.raises(IntegrityError), transaction.atomic():
        WebhookDelivery.objects.filter(pk=row.pk).update(**change)


def test_legitimate_retry_states_allowed(ep):
    row = delivery(ep)
    # pending again after a claim keeps claimed_at (history) with no lease: allowed
    WebhookDelivery.objects.filter(pk=row.pk).update(state="pending", claimed_at=timezone.now(), lease_expires_at=None)
    WebhookDelivery.objects.filter(pk=row.pk).update(state="failed", lease_expires_at=None)


# ================================================================== 4. indexes

class TestIndexes:
    def plan(self, qs):
        sql, params = qs.query.sql_with_params()
        with connection.cursor() as cur:
            cur.execute("SET LOCAL enable_seqscan = off")
            cur.execute("EXPLAIN " + sql, params)
            return "\n".join(r[0] for r in cur.fetchall())

    def test_queries_use_the_new_indexes(self, ep):
        delivery(ep, state="delivered", delivered_at=timezone.now())
        now = timezone.now()
        assert "delivery_endpoint_newest" in self.plan(
            WebhookDelivery.objects.filter(endpoint=ep).order_by("-created_at", "-id")[:101])
        assert "delivery_finished_created" in self.plan(
            WebhookDelivery.objects.filter(created_at__lt=now, state__in=["delivered", "failed"])
            .values_list("pk", flat=True)[:1000])
        assert "delivery_processing_lease" in self.plan(
            WebhookDelivery.objects.filter(state="processing", lease_expires_at__lt=now).values_list("pk", flat=True)[:500])

    def test_index_set(self):
        with connection.cursor() as cur:
            cur.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'automation_webhookdelivery'")
            names = {r[0] for r in cur.fetchall()}
        assert {"delivery_endpoint_newest", "delivery_finished_created", "delivery_processing_lease",
                "unique_webhook_event_delivery"} <= names
        assert "delivery_state_lease" not in names
        assert not any(n.startswith("automation_webhookdelivery_endpoint_id") for n in names)
        assert any(n.startswith("automation_webhookdelivery_workspace_id") for n in names)
        assert any(n.startswith("automation_webhookdelivery_redelivery_of_id") for n in names)


# ------------------------------------------- migration: backfill + report, no cleanup

@pytest.mark.django_db(transaction=True)
def test_migration_backfills_flag_and_reports_bad_states(ep):
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    created = []
    try:
        MigrationExecutor(connection).migrate([("automation", "0005_drop_redundant_indexes")])
        with connection.cursor() as cur:
            insert = ("INSERT INTO automation_webhookdelivery (created_at, updated_at, workspace_id, endpoint_id, "
                      "event_id, event, payload, state, attempts, response_body, last_error, claim_token, "
                      "redelivery_of_id, delivered_at) VALUES (now(), now(), %s, %s, %s, 'e', '{}', %s, 0, '', '', '', "
                      "%s, %s) RETURNING id")
            ev = uuid.uuid4()
            cur.execute(insert, [ep.workspace_id, ep.pk, ev, "failed", None, None])
            created.append(cur.fetchone()[0])
            cur.execute(insert, [ep.workspace_id, ep.pk, ev, "failed", created[0], None])
            created.append(cur.fetchone()[0])
        latest()  # clean data: migrates, and backfills the flag
        assert WebhookDelivery.objects.get(pk=created[1]).is_redelivery is True
        assert WebhookDelivery.objects.get(pk=created[0]).is_redelivery is False

        MigrationExecutor(connection).migrate([("automation", "0005_drop_redundant_indexes")])
        with connection.cursor() as cur:
            cur.execute("UPDATE automation_webhookdelivery SET state = 'delivered', delivered_at = NULL WHERE id = %s",
                        [created[0]])
        with pytest.raises(RuntimeError, match=str(created[0])):
            latest()
    finally:
        with connection.cursor() as cur:
            cur.execute("DELETE FROM automation_webhookdelivery WHERE id = ANY(%s)", [created])
        latest()
