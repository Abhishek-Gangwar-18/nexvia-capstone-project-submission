"""Group 6 hardening: double checkout, customer idempotency, duplicate subscriptions, lock order and stale
snapshots, owner email, throttles, webhook transaction boundaries and errors, retention, over-limit, deletion."""
import hashlib
import hmac
import json
import threading
import time
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
import stripe
from django.db import IntegrityError, connection
from django.utils import timezone

from apps.automation.tasks import purge_old_records
from apps.billing import services
from apps.billing.models import StripeEvent, Subscription
from apps.billing.tasks import update_billing_email
from apps.issues.models import AuditLog
from apps.projects.services import create_project
from apps.tenants.models import Membership, Workspace

Role = Membership.Role
SECRET = "whsec_unit_test"


@pytest.fixture(autouse=True)
def fake_keys(settings):
    settings.STRIPE_SECRET_KEY = "sk_test_unit"
    settings.STRIPE_WEBHOOK_SECRET = SECRET


def sub(status="active", sub_id="sub_1", created=1, lookup_key="flowboard_pro_monthly"):
    return {"id": sub_id, "status": status, "created": created, "cancel_at_period_end": False,
            "items": {"data": [{"current_period_end": 1900000000, "price": {"id": "price_x", "lookup_key": lookup_key}}]}}


@pytest.fixture
def fake(monkeypatch):
    client = MagicMock()
    client.v1.subscriptions.list.return_value = SimpleNamespace(data=[sub()])
    client.v1.customers.create.return_value = SimpleNamespace(id="cus_1")
    client.v1.prices.list.return_value = SimpleNamespace(data=[SimpleNamespace(id="price_pro")])
    client.v1.checkout.sessions.create.return_value = SimpleNamespace(id="cs_1", url="https://checkout.test/1")
    client.v1.checkout.sessions.retrieve.return_value = {
        "id": "cs_1", "status": "open", "url": "https://checkout.test/1", "expires_at": time.time() + 3600}
    monkeypatch.setattr(services, "client", lambda: client)
    return client


def link(workspace, **kwargs):
    return Subscription.objects.create(workspace=workspace, stripe_customer_id="cus_1", **kwargs)


def webhook(api, event):
    body = json.dumps(event)
    timestamp = int(time.time())
    signature = hmac.new(SECRET.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()
    return api().post("/api/billing/webhook/", body, content_type="application/json",
                      HTTP_STRIPE_SIGNATURE=f"t={timestamp},v1={signature}")


def event(event_type, obj, event_id="evt_1"):
    return {"id": event_id, "object": "event", "type": event_type, "data": {"object": obj}}


def owner(api, tenant):
    return api(tenant["owner"], tenant["workspace"])


# ------------------------------------------------------------- 1. double checkout

@pytest.mark.django_db
class TestCheckout:
    def test_open_session_is_reused_with_idempotency_key(self, api, tenant_a, fake):
        client = owner(api, tenant_a)
        first = client.post("/api/billing/checkout/", {"plan": "pro"}, format="json")
        second = client.post("/api/billing/checkout/", {"plan": "pro"}, format="json")
        assert first.data["url"] == second.data["url"] == "https://checkout.test/1"
        assert fake.v1.checkout.sessions.create.call_count == 1
        key = fake.v1.checkout.sessions.create.call_args.kwargs["options"]["idempotency_key"]
        assert key.startswith(f"checkout-ws-{tenant_a['workspace'].pk}-pro-")
        assert fake.v1.checkout.sessions.create.call_args.kwargs["params"]["line_items"][0]["price"] == "price_pro"

    @pytest.mark.parametrize("session", [
        {"status": "complete", "url": "u", "expires_at": time.time() + 3600},
        {"status": "expired", "url": "u", "expires_at": time.time() - 10},
        {"status": "open", "url": "u", "expires_at": time.time() + 30},  # about to expire
    ])
    def test_finished_or_expiring_sessions_are_not_reused(self, api, tenant_a, fake, session):
        link(tenant_a["workspace"], checkout_session_id="cs_old", checkout_plan="pro")
        fake.v1.checkout.sessions.retrieve.return_value = session
        owner(api, tenant_a).post("/api/billing/checkout/", {"plan": "pro"}, format="json")
        assert fake.v1.checkout.sessions.create.call_count == 1

    def test_other_plan_gets_a_new_session(self, api, tenant_a, fake):
        link(tenant_a["workspace"], checkout_session_id="cs_old", checkout_plan="pro")
        owner(api, tenant_a).post("/api/billing/checkout/", {"plan": "enterprise"}, format="json")
        fake.v1.checkout.sessions.retrieve.assert_not_called()
        assert fake.v1.checkout.sessions.create.call_count == 1

    @pytest.mark.parametrize("body", [{"plan": None}, {"plan": ""}, {"plan": 1}, {"plan": "price_pro"}])
    def test_plan_is_validated(self, api, tenant_a, body):
        assert owner(api, tenant_a).post("/api/billing/checkout/", body, format="json").status_code == 400


@pytest.mark.django_db(transaction=True)
def test_concurrent_checkouts_open_one_session(tenant_a, fake):
    """The advisory lock serialises the tabs; the second one finds the first one's open session."""
    def slow_create(**kwargs):
        time.sleep(0.3)
        return SimpleNamespace(id="cs_1", url="https://checkout.test/1")

    fake.v1.checkout.sessions.create.side_effect = slow_create
    urls = []

    def tab():
        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(tenant_a["owner"])
        client.credentials(HTTP_X_WORKSPACE=tenant_a["workspace"].slug)
        urls.append(client.post("/api/billing/checkout/", {"plan": "pro"}, format="json").data.get("url"))
        connection.close()

    threads = [threading.Thread(target=tab) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert urls == ["https://checkout.test/1"] * 3
    assert fake.v1.checkout.sessions.create.call_count == 1
    assert fake.v1.customers.create.call_count == 1
    assert Subscription.objects.filter(workspace=tenant_a["workspace"]).count() == 1


# ------------------------------------------------------------------- 2. customer

@pytest.mark.django_db
class TestCustomer:
    def test_stable_idempotency_key(self, tenant_a, fake):
        services.get_or_create_customer(fake, tenant_a["workspace"])
        assert fake.v1.customers.create.call_args.kwargs["options"] == {
            "idempotency_key": f"customer-ws-{tenant_a['workspace'].pk}"}

    def test_lost_race_returns_the_saved_row(self, tenant_a, fake):
        ws = tenant_a["workspace"]
        competitor = link(ws)  # committed by the other request
        lookups = MagicMock()
        lookups.first.side_effect = [None, competitor]  # our first check missed it; the re-check finds it
        with patch.object(Subscription.objects, "filter", return_value=lookups), \
             patch.object(Subscription.objects, "create", side_effect=IntegrityError("duplicate")):
            record = services.get_or_create_customer(fake, ws)
        assert record == competitor

    def test_unsaved_customer_is_logged(self, tenant_a, fake, caplog):
        with patch.object(Subscription.objects, "create", side_effect=IntegrityError("db down")), \
             pytest.raises(IntegrityError):
            services.get_or_create_customer(fake, tenant_a["workspace"])
        assert "cus_1" in caplog.text and "could not be saved" in caplog.text


# --------------------------------------------------------- 1 (cont). duplicates

@pytest.mark.django_db
class TestDuplicateSubscriptions:
    def test_extras_cancelled_oldest_kept(self, api, tenant_a, fake):
        link(tenant_a["workspace"])
        fake.v1.subscriptions.list.return_value = SimpleNamespace(data=[
            sub(sub_id="sub_new", created=20), sub(sub_id="sub_old", created=10), sub("canceled", "sub_gone", 5)])
        assert webhook(api, event("checkout.session.completed", {"customer": "cus_1", "subscription": "sub_new"})).status_code == 200
        fake.v1.subscriptions.cancel.assert_called_once_with(
            "sub_new", options={"idempotency_key": "cancel-duplicate-sub_new"})
        assert Subscription.objects.get().stripe_subscription_id == "sub_old"
        record = AuditLog.objects.get(changes__duplicate_subscription__cancelled_subscription="sub_new")
        details = record.changes["duplicate_subscription"]
        assert details["workspace_id"] == tenant_a["workspace"].pk and details["retained_subscription"] == "sub_old"
        assert details["cancellation_result"] == "cancelled" and details["detected_at"]
        assert details["refund_issued"] is False and details["manual_refund_review_required"] is True

    def test_failed_cancel_is_retried_by_stripe(self, api, tenant_a, fake):
        link(tenant_a["workspace"])
        fake.v1.subscriptions.list.return_value = SimpleNamespace(data=[sub(sub_id="a", created=1), sub(sub_id="b", created=2)])
        fake.v1.subscriptions.cancel.side_effect = stripe.APIConnectionError("down")
        res = webhook(api, event("customer.subscription.created", {"id": "b", "customer": "cus_1"}))
        assert res.status_code == 503 and not StripeEvent.objects.exists()  # retry will run it again
        details = AuditLog.objects.get(changes__duplicate_subscription__cancelled_subscription="b").changes["duplicate_subscription"]
        assert details["cancellation_result"].startswith("cancel failed") and details["refund_issued"] is False


# ----------------------------------------------- 4 and 8. lock order and freshness

@pytest.mark.django_db
class TestApply:
    def test_overlap_earlier_start_finishing_later_loses(self, tenant_a, fake):
        """Webhook A starts fetching, sync B starts later and applies first; A must not overwrite B."""
        record = link(tenant_a["workspace"])
        fake.v1.subscriptions.list.return_value = SimpleNamespace(data=[sub("active")])
        prepared_a = services.prepare_event(event("customer.subscription.updated", {"id": "sub_1", "customer": "cus_1"}))
        time.sleep(0.01)
        fake.v1.subscriptions.list.return_value = SimpleNamespace(data=[sub("canceled")])
        services.sync_workspace(tenant_a["workspace"])  # B: started after A, finishes first
        services.apply_event(event("customer.subscription.updated", {}), prepared_a)  # A finishes last
        record.refresh_from_db()
        assert record.status == "canceled"
        assert Workspace.objects.get(pk=tenant_a["workspace"].pk).plan == "free"

    def test_stale_snapshot_is_discarded(self, tenant_a):
        record = link(tenant_a["workspace"], synced_at=timezone.now())
        old_fetch = timezone.now() - timedelta(seconds=5)
        services.apply_subscription(record.pk, sub("canceled"), old_fetch)
        record.refresh_from_db()
        assert record.status == ""  # untouched: a newer snapshot was already applied

    def test_lock_order_workspace_then_subscription(self, tenant_a):
        from django.test.utils import CaptureQueriesContext
        record = link(tenant_a["workspace"])
        with CaptureQueriesContext(connection) as queries:
            services.apply_subscription(record.pk, sub(), timezone.now())
        locks = [q["sql"] for q in queries.captured_queries if "FOR UPDATE" in q["sql"]]
        assert "tenants_workspace" in locks[0] and "billing_subscription" in locks[1]

    def test_unknown_price_logged_and_plan_kept(self, tenant_a, caplog):
        record = link(tenant_a["workspace"])
        services.apply_subscription(record.pk, sub(lookup_key="mystery_price"), timezone.now())
        assert Workspace.objects.get(pk=tenant_a["workspace"].pk).plan == "free"
        assert "unknown prices" in caplog.text and "mystery_price" in caplog.text

    def test_stripe_is_called_outside_the_transaction(self, api, tenant_a, fake):
        link(tenant_a["workspace"])
        seen = []
        fake.v1.subscriptions.list.side_effect = lambda **kw: (
            seen.append(connection.in_atomic_block) or SimpleNamespace(data=[sub()]))
        # pytest-django wraps each test in a transaction, so "outside" means no *extra* atomic level here.
        depth = len(connection.savepoint_ids)
        fake.v1.subscriptions.list.side_effect = lambda **kw: (
            seen.append(len(connection.savepoint_ids) - depth) or SimpleNamespace(data=[sub()]))
        webhook(api, event("customer.subscription.updated", {"id": "sub_1", "customer": "cus_1"}))
        assert seen == [0]


# ----------------------------------------------------------- 3. owner email

@pytest.mark.django_db
class TestBillingEmail:
    def test_transfer_queues_update_after_commit(self, api, tenant_a, make_user, add_member, fake,
                                                django_capture_on_commit_callbacks, monkeypatch):
        ws = tenant_a["workspace"]
        link(ws)
        new_owner = make_user("next@g6.test")
        membership = add_member(ws, new_owner, Role.ADMIN)
        queued = MagicMock(return_value=None)
        monkeypatch.setattr("apps.automation.queue.enqueue", queued)
        with django_capture_on_commit_callbacks(execute=True):
            res = owner(api, tenant_a).post("/api/workspace/transfer-ownership/",
                                            {"member_id": membership.pk}, format="json")
        assert res.status_code == 200
        assert queued.call_args.args == (update_billing_email, ws.pk)

    def test_task_uses_the_current_owner(self, tenant_a, make_user, fake):
        ws = tenant_a["workspace"]
        link(ws)
        latest = make_user("latest@g6.test")
        Workspace.objects.filter(pk=ws.pk).update(owner=latest)  # ownership moved again before the task ran
        assert update_billing_email(ws.pk) == "latest@g6.test"
        fake.v1.customers.update.assert_called_once_with("cus_1", params={"email": "latest@g6.test"})

    def test_failures_retry(self, tenant_a, fake):
        link(tenant_a["workspace"])
        assert stripe.StripeError in update_billing_email.autoretry_for


# ------------------------------------------------------------ 5 and 6. throttles

@pytest.mark.django_db
class TestThrottles:
    def test_checkout_and_portal_share_10_per_minute(self, api, tenant_a, fake):
        link(tenant_a["workspace"])
        fake.v1.billing_portal.sessions.create.return_value = SimpleNamespace(url="https://portal.test")
        client = owner(api, tenant_a)
        codes = [client.post("/api/billing/portal/").status_code for _ in range(10)]
        codes.append(client.post("/api/billing/checkout/", {"plan": "pro"}, format="json").status_code)
        assert codes[:10] == [200] * 10 and codes[10] == 429

    def test_sync_6_per_minute_per_workspace(self, api, tenant_a, fake):
        client = owner(api, tenant_a)
        codes = [client.post("/api/billing/sync/").status_code for _ in range(7)]
        assert codes == [200] * 6 + [429]

    def test_sync_is_owner_only(self, api, tenant_a, make_user, add_member):
        admin = make_user("adm@g6.test")
        add_member(tenant_a["workspace"], admin, Role.ADMIN)
        assert api(admin, tenant_a["workspace"]).post("/api/billing/sync/").status_code == 403

    def test_counters_live_in_the_shared_cache(self, settings):
        assert settings.CACHES["default"]["BACKEND"].endswith("RedisCache")


# ---------------------------------------------------------- 9 and 10. webhook

@pytest.mark.django_db
class TestWebhookErrors:
    def test_unexpected_error_is_500_logged_and_leaves_no_event(self, api, tenant_a, fake, caplog):
        link(tenant_a["workspace"])
        with patch.object(services, "apply_subscription", side_effect=KeyError("boom")):
            res = webhook(api, event("customer.subscription.updated", {"id": "sub_1", "customer": "cus_1"}, "evt_x"))
        assert res.status_code == 500
        assert not StripeEvent.objects.filter(event_id="evt_x").exists()
        assert "evt_x" in caplog.text and "customer.subscription.updated" in caplog.text
        assert SECRET not in caplog.text and "sk_test_unit" not in caplog.text

    def test_known_duplicate_skips_stripe(self, api, tenant_a, fake):
        link(tenant_a["workspace"])
        StripeEvent.objects.create(event_id="evt_dup", event_type="customer.subscription.updated")
        res = webhook(api, event("customer.subscription.updated", {"id": "sub_1", "customer": "cus_1"}, "evt_dup"))
        assert res.data["duplicate"] is True
        fake.v1.subscriptions.list.assert_not_called()

    def test_stripe_events_purged_after_90_days(self):
        old = StripeEvent.objects.create(event_id="evt_old", event_type="x")
        new = StripeEvent.objects.create(event_id="evt_new", event_type="x")
        StripeEvent.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=91))
        assert purge_old_records()["stripe_events"] == 1
        assert list(StripeEvent.objects.values_list("pk", flat=True)) == [new.pk]


# ------------------------------------------------------------------ 11. over limit

@pytest.mark.django_db
def test_over_limit_reported_after_downgrade(api, tenant_a, make_user, add_member):
    ws = tenant_a["workspace"]
    client = owner(api, tenant_a)
    assert client.get("/api/billing/").data["over_limit"] == {"projects": None, "members": None}
    for i in range(4):
        create_project(workspace=ws, name=f"P{i}", key=f"PX{i}", created_by=tenant_a["owner"])
    data = client.get("/api/billing/").data
    assert data["over_limit"]["projects"] == {"used": 5, "limit": 3} and data["over_limit"]["members"] is None
    assert client.patch("/api/projects/PX0/", {"name": "still editable"}, format="json").status_code == 200


# --------------------------------------------------------------- 12. deletion

@pytest.mark.django_db
class TestDeletion:
    def body(self, tenant):
        return {"confirm": tenant["workspace"].slug, "password": "pass12345"}

    def test_cancel_then_failed_delete_then_retry(self, api, tenant_a, fake):
        ws = tenant_a["workspace"]
        link(ws, stripe_subscription_id="sub_1", status="active")
        client = owner(api, tenant_a)
        with patch.object(Workspace, "delete", side_effect=RuntimeError("db hiccup")), pytest.raises(RuntimeError):
            client.delete("/api/workspace/", self.body(tenant_a), format="json")
        assert fake.v1.subscriptions.cancel.call_count == 1
        assert Subscription.objects.get(workspace=ws).status == "canceled"  # saved despite the failed delete
        assert client.delete("/api/workspace/", self.body(tenant_a), format="json").status_code == 204
        assert fake.v1.subscriptions.cancel.call_count == 1  # the retry didn't cancel again

    def test_cancel_failure_blocks_deletion(self, api, tenant_a, fake):
        link(tenant_a["workspace"], stripe_subscription_id="sub_1", status="active")
        fake.v1.subscriptions.cancel.side_effect = stripe.APIConnectionError("down")
        res = owner(api, tenant_a).delete("/api/workspace/", self.body(tenant_a), format="json")
        assert res.status_code == 503 and Workspace.objects.filter(pk=tenant_a["workspace"].pk).exists()
