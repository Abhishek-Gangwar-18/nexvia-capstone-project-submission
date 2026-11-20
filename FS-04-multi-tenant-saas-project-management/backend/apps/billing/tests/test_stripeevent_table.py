"""Schema review, table #21 (billing_stripeevent): only the event-row insert can mean "duplicate" (its own
savepoint); an apply-time IntegrityError is a 500 that Stripe retries, leaving no row; read-only admin;
non-empty event_id; pattern-ops index dropped; created_at index for retention."""
import hashlib
import hmac
import json
import logging
import threading
import time
from unittest.mock import patch

import pytest
from django.contrib.admin.sites import site
from django.db import IntegrityError, connection, transaction

from apps.billing import services
from apps.billing.models import StripeEvent
from apps.tenants.models import Workspace

pytestmark = pytest.mark.django_db
SECRET = "whsec_table21"


@pytest.fixture(autouse=True)
def keys(settings):
    settings.STRIPE_WEBHOOK_SECRET = SECRET
    settings.STRIPE_SECRET_KEY = "sk_test_unit"


def body_for(event_id="evt_21", event_type="customer.subscription.updated"):
    return json.dumps({"id": event_id, "type": event_type, "object": "event",
                       "data": {"object": {"id": "sub_1", "customer": "cus_private_123", "object": "subscription"}}})


def post(client, body):
    ts = int(time.time())
    sig = hmac.new(SECRET.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return client.post("/api/billing/webhook/", body, content_type="application/json", HTTP_STRIPE_SIGNATURE=f"t={ts},v1={sig}")


def stubbed(apply):
    return patch.multiple(services, prepare_event=lambda event: None, apply_event=apply)


# ===================================================== 1. duplicates vs apply failures

class TestDuplicateScope:
    def test_1_known_event_is_a_200_duplicate(self, api):
        StripeEvent.objects.create(event_id="evt_21", event_type="customer.subscription.updated")
        calls = []
        with stubbed(lambda e, p: calls.append(e)):
            res = post(api(), body_for())
        assert res.status_code == 200 and res.data["duplicate"] is True and calls == []

    def test_3_insert_time_unique_violation_is_a_duplicate(self, api):
        """The pre-check misses (row committed between the check and the insert): the insert's own savepoint
        catches the unique violation."""
        calls = []
        real_filter = StripeEvent.objects.filter

        def racing_prepare(event):
            StripeEvent.objects.create(event_id="evt_21", event_type="x")  # the parallel delivery commits first
        with patch.object(services, "prepare_event", racing_prepare), \
                patch.object(services, "apply_event", lambda e, p: calls.append(e)):
            res = post(api(), body_for())
        assert res.status_code == 200 and res.data["duplicate"] is True and calls == []
        assert real_filter(event_id="evt_21").count() == 1

    def test_4_5_6_apply_time_integrity_error_is_a_500_with_no_row(self, api, caplog):
        def broken(event, prepared):
            raise IntegrityError('duplicate key value violates unique constraint "uq_subscription_stripe_id"')

        with stubbed(broken), caplog.at_level(logging.ERROR):
            res = post(api(), body_for())
        assert res.status_code == 500 and "duplicate" not in res.data
        assert not StripeEvent.objects.filter(event_id="evt_21").exists()  # rolled back with the change
        logged = caplog.text
        assert "evt_21" in logged and "customer.subscription.updated" in logged
        assert "cus_private_123" not in logged  # no customer/payment data in the log

    def test_7_retry_after_the_fix_applies_the_event(self, api):
        def broken(event, prepared):
            raise IntegrityError("boom")

        with stubbed(broken):
            assert post(api(), body_for()).status_code == 500
        applied = []
        with stubbed(lambda e, p: applied.append(e["id"])):
            res = post(api(), body_for())  # Stripe's retry
        assert res.status_code == 200 and "duplicate" not in res.data and applied == ["evt_21"]
        assert StripeEvent.objects.filter(event_id="evt_21").count() == 1

    def test_8_change_and_event_row_commit_or_roll_back_together(self, api, tenant_a):
        ws = tenant_a["workspace"]

        def change_then_fail(event, prepared):
            Workspace.objects.filter(pk=ws.pk).update(plan="pro")
            raise IntegrityError("late failure")

        with stubbed(change_then_fail):
            assert post(api(), body_for("evt_a")).status_code == 500
        assert Workspace.objects.get(pk=ws.pk).plan == "free" and not StripeEvent.objects.filter(event_id="evt_a").exists()

        with stubbed(lambda e, p: Workspace.objects.filter(pk=ws.pk).update(plan="pro")):
            assert post(api(), body_for("evt_b")).status_code == 200
        assert Workspace.objects.get(pk=ws.pk).plan == "pro" and StripeEvent.objects.filter(event_id="evt_b").exists()


@pytest.mark.django_db(transaction=True)
def test_2_parallel_deliveries_apply_once():
    from rest_framework.test import APIClient

    applied, codes, barrier = [], [], threading.Barrier(2)
    lock = threading.Lock()

    def slow_prepare(event):
        barrier.wait()  # both pass the pre-check before either inserts
        return None

    def apply(event, prepared):
        with lock:
            applied.append(event["id"])
        time.sleep(0.2)  # hold the transaction so the other insert must wait on the unique index

    def deliver():
        codes.append(post(APIClient(), body_for()).data)
        connection.close()

    with patch.multiple(services, prepare_event=slow_prepare, apply_event=apply):
        threads = [threading.Thread(target=deliver) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
    assert applied == ["evt_21"]
    assert sorted(d.get("duplicate", False) for d in codes) == [False, True]
    assert StripeEvent.objects.filter(event_id="evt_21").count() == 1


# =============================================================== 2-3. integrity

def test_9_empty_event_id_rejected():
    with pytest.raises(IntegrityError), transaction.atomic():
        StripeEvent.objects.create(event_id="", event_type="x")


class TestAdmin:
    @pytest.fixture
    def request_(self, rf, make_user):
        request = rf.get("/")
        request.user = make_user("staff@x.test", is_staff=True, is_superuser=True)
        return request

    def test_11_no_add_change_or_delete(self, request_):
        admin = site._registry[StripeEvent]
        row = StripeEvent.objects.create(event_id="evt_x", event_type="t")
        assert not admin.has_add_permission(request_)
        assert not admin.has_change_permission(request_, row)
        assert not admin.has_delete_permission(request_, row)

    def test_12_listing_and_search_still_work(self, request_):
        StripeEvent.objects.create(event_id="evt_find_me", event_type="invoice.paid")
        StripeEvent.objects.create(event_id="evt_other", event_type="customer.created")
        admin = site._registry[StripeEvent]
        assert admin.has_view_permission(request_)
        results, _ = admin.get_search_results(request_, StripeEvent.objects.all(), "find_me")
        assert [r.event_id for r in results] == ["evt_find_me"]
        assert admin.get_queryset(request_).count() == 2


# ================================================================ 4-5. indexes

def test_13_14_15_indexes():
    with connection.cursor() as cur:
        cur.execute("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'billing_stripeevent'")
        defs = dict(cur.fetchall())
    assert not any("varchar_pattern_ops" in d for d in defs.values())
    assert any("UNIQUE" in d and "(event_id)" in d for d in defs.values())
    assert defs["stripeevent_created"].endswith("btree (created_at)")


def test_retention_uses_the_created_at_index():
    StripeEvent.objects.create(event_id="evt_old", event_type="t")
    with connection.cursor() as cur:
        cur.execute("SET LOCAL enable_seqscan = off")
        cur.execute("EXPLAIN SELECT id FROM billing_stripeevent WHERE created_at < now() - interval '90 days' LIMIT 1000")
        plan = "\n".join(r[0] for r in cur.fetchall())
    assert "stripeevent_created" in plan


# ------------------------------------------------- 10. migration: report, no changes

@pytest.mark.django_db(transaction=True)
def test_10_migration_reports_empty_event_ids():
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    row_id = None
    try:
        MigrationExecutor(connection).migrate([("billing", "0004_subscription_integrity")])
        with connection.cursor() as cur:
            cur.execute("INSERT INTO billing_stripeevent (created_at, event_id, event_type) VALUES (now(), '', 'x') "
                        "RETURNING id")
            row_id = cur.fetchone()[0]
        with pytest.raises(RuntimeError, match=str(row_id)):
            latest()
        with connection.cursor() as cur:
            cur.execute("SELECT event_id FROM billing_stripeevent WHERE id = %s", [row_id])
            assert cur.fetchone()[0] == ""  # untouched
    finally:
        with connection.cursor() as cur:
            cur.execute("DELETE FROM billing_stripeevent WHERE id = %s", [row_id])
        latest()
