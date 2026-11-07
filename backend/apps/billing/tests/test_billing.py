import hashlib
import hmac
import json
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import stripe
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.billing import services
from apps.billing.models import StripeEvent, Subscription
from apps.issues.models import AuditLog, Issue
from apps.projects.services import create_project
from apps.tenants.models import Invitation, Membership, Workspace

pytestmark = pytest.mark.django_db
Role = Membership.Role
SECRET = "whsec_unit_test"


@pytest.fixture(autouse=True)
def fake_keys(settings):
    """These tests must never reach the real Stripe account."""
    settings.STRIPE_SECRET_KEY = "sk_test_unit"
    settings.STRIPE_WEBHOOK_SECRET = SECRET


@pytest.fixture
def team(tenant_a, make_user, add_member):
    workspace = tenant_a["workspace"]
    users = {"owner": tenant_a["owner"]}
    for role in (Role.ADMIN, Role.MEMBER, Role.VIEWER):
        users[role] = make_user(f"{role}@billing.test")
        add_member(workspace, users[role], role)
    return {**tenant_a, "users": users}


def stripe_subscription(status="active", lookup_key="flowboard_pro_monthly", sub_id="sub_1"):
    return {
        "id": sub_id, "status": status, "created": 1, "cancel_at_period_end": False,
        "items": {"data": [{"current_period_end": 1900000000, "price": {"lookup_key": lookup_key}}]},
    }


def link(team, **kwargs):
    return Subscription.objects.create(workspace=team["workspace"], stripe_customer_id="cus_1", **kwargs)


def webhook(api, event, secret=SECRET):
    body = json.dumps(event)
    timestamp = int(time.time())
    signature = hmac.new(secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()
    return api().post(
        "/api/billing/webhook/", body, content_type="application/json",
        HTTP_STRIPE_SIGNATURE=f"t={timestamp},v1={signature}",
    )


def event(event_type, obj, event_id="evt_1"):
    return {"id": event_id, "object": "event", "type": event_type, "data": {"object": obj}}


@pytest.fixture
def fake_client(monkeypatch):
    fake = MagicMock()
    # Webhooks and sync read all of the customer's subscriptions (to catch duplicates), not just one.
    fake.v1.subscriptions.list.return_value = SimpleNamespace(data=[stripe_subscription()])
    monkeypatch.setattr(services, "client", lambda: fake)
    return fake


class TestLimits:
    def test_free_project_limit_then_upgrade_lifts_it(self, api, team):
        for key in ("AA", "BB"):
            create_project(workspace=team["workspace"], name=key, key=key)
        client = api(team["owner"], team["workspace"])
        res = client.post("/api/projects/", {"name": "x", "key": "CC"}, format="json")
        assert res.status_code == 402
        assert res.data["code"] == "plan_limit_reached" and res.data["limit"] == "projects"
        Workspace.objects.filter(pk=team["workspace"].pk).update(plan="pro")
        assert client.post("/api/projects/", {"name": "x", "key": "CC"}, format="json").status_code == 201

    def test_archived_projects_free_a_slot_but_restore_is_checked(self, api, team):
        a = create_project(workspace=team["workspace"], name="A", key="AA")
        create_project(workspace=team["workspace"], name="B", key="BB")
        client = api(team["owner"], team["workspace"])
        assert client.patch(f"/api/projects/{a.key}/", {"is_archived": True}, format="json").status_code == 200
        assert client.post("/api/projects/", {"name": "x", "key": "CC"}, format="json").status_code == 201
        assert client.patch(f"/api/projects/{a.key}/", {"is_archived": False}, format="json").status_code == 402

    def test_member_limit_counts_pending_invitations(self, api, team):
        client = api(team["owner"], team["workspace"])
        assert client.post("/api/invitations/", {"email": "a@x.test"}, format="json").status_code == 201
        res = client.post("/api/invitations/", {"email": "b@x.test"}, format="json")
        assert res.status_code == 402 and res.data["limit"] == "members"
        assert Invitation.objects.filter(email="b@x.test").count() == 0

    def test_file_size_follows_the_plan(self, api, team, settings, tmp_path):
        settings.MEDIA_ROOT = tmp_path
        issue = Issue.objects.create(project=team["project"], title="a")
        client = api(team["owner"], team["workspace"])
        big = lambda: SimpleUploadedFile("big.txt", b"x" * (11 * 1024 * 1024), content_type="text/plain")
        url = f"/api/issues/{issue.key}/attachments/"
        res = client.post(url, {"file": big()}, format="multipart")
        assert res.status_code == 402 and res.data["limit"] == "file_size"
        Workspace.objects.filter(pk=team["workspace"].pk).update(plan="pro")
        assert client.post(url, {"file": big()}, format="multipart").status_code == 201

    def test_downgraded_workspace_keeps_working_but_cant_add(self, api, team):
        for key in ("AA", "BB", "DD"):
            create_project(workspace=team["workspace"], name=key, key=key)
        client = api(team["owner"], team["workspace"])
        assert client.get("/api/projects/").status_code == 200
        assert client.post("/api/issues/", {"project": team["project"].pk, "title": "still ok"}, format="json").status_code == 201
        assert client.post("/api/projects/", {"name": "x", "key": "EE"}, format="json").status_code == 402

    def test_enterprise_is_unlimited(self, api, team):
        Workspace.objects.filter(pk=team["workspace"].pk).update(plan="enterprise")
        for key in ("AA", "BB", "DD", "EE"):
            create_project(workspace=team["workspace"], name=key, key=key)
        client = api(team["owner"], team["workspace"])
        assert client.post("/api/projects/", {"name": "x", "key": "FF"}, format="json").status_code == 201


class TestApi:
    def test_state_shows_usage_and_role(self, api, team):
        owner = api(team["owner"], team["workspace"]).get("/api/billing/").data
        assert owner["plan"] == "free" and owner["can_manage"] is True
        assert owner["usage"] == {"projects": 1, "members": 4, "pending_invitations": 0}
        assert [p["id"] for p in owner["plans"]] == ["free", "pro", "enterprise"]
        assert api(team["users"][Role.VIEWER], team["workspace"]).get("/api/billing/").data["can_manage"] is False

    def test_state_never_exposes_stripe_ids_or_keys(self, api, team):
        link(team, stripe_subscription_id="sub_secret", status="active")
        text = json.dumps(api(team["owner"], team["workspace"]).get("/api/billing/").data, default=str)
        assert "cus_1" not in text and "sub_secret" not in text and "sk_test" not in text

    @pytest.mark.parametrize("path", ["/api/billing/checkout/", "/api/billing/portal/", "/api/billing/sync/"])
    def test_payment_actions_are_owner_only(self, api, team, path):
        res = api(team["users"][Role.ADMIN], team["workspace"]).post(path, {"plan": "pro"}, format="json")
        assert res.status_code == 403

    def test_workspace_isolation(self, api, team, tenant_b):
        assert api(team["owner"], tenant_b["workspace"]).get("/api/billing/").status_code == 404

    def test_checkout_creates_customer_once_and_returns_url(self, api, team, fake_client):
        fake_client.v1.customers.create.return_value = SimpleNamespace(id="cus_new")
        fake_client.v1.prices.list.return_value = SimpleNamespace(data=[SimpleNamespace(id="price_pro")])
        fake_client.v1.checkout.sessions.create.return_value = SimpleNamespace(url="https://checkout.test/x")
        client = api(team["owner"], team["workspace"])
        for _ in range(2):
            res = client.post("/api/billing/checkout/", {"plan": "pro"}, format="json")
            assert res.status_code == 200 and res.data["url"] == "https://checkout.test/x"
        assert fake_client.v1.customers.create.call_count == 1
        params = fake_client.v1.checkout.sessions.create.call_args.kwargs["params"]
        assert params["customer"] == "cus_new" and params["line_items"][0]["price"] == "price_pro"
        assert params["mode"] == "subscription" and "/w/acme/billing" in params["success_url"]

    @pytest.mark.parametrize("body", [{"plan": "free"}, {"plan": "nope"}, {"plan": ["pro"]}, {"plan": {"a": 1}}, {}, ["x"]])
    def test_checkout_rejects_bad_plans(self, api, team, body):
        assert api(team["owner"], team["workspace"]).post("/api/billing/checkout/", body, format="json").status_code == 400

    def test_checkout_refused_when_already_subscribed(self, api, team, fake_client):
        link(team, stripe_subscription_id="sub_1", status="active")
        res = api(team["owner"], team["workspace"]).post("/api/billing/checkout/", {"plan": "enterprise"}, format="json")
        assert res.status_code == 400
        fake_client.v1.checkout.sessions.create.assert_not_called()

    def test_stripe_errors_become_a_clean_503(self, api, team, fake_client):
        fake_client.v1.customers.create.side_effect = stripe.APIConnectionError("secret detail")
        res = api(team["owner"], team["workspace"]).post("/api/billing/checkout/", {"plan": "pro"}, format="json")
        assert res.status_code == 503 and "secret detail" not in str(res.data)

    def test_missing_key_is_a_clean_503(self, api, team, settings):
        settings.STRIPE_SECRET_KEY = ""
        res = api(team["owner"], team["workspace"]).post("/api/billing/checkout/", {"plan": "pro"}, format="json")
        assert res.status_code == 503

    def test_portal_needs_a_billing_account(self, api, team, fake_client):
        client = api(team["owner"], team["workspace"])
        assert client.post("/api/billing/portal/").status_code == 400
        link(team)
        fake_client.v1.billing_portal.sessions.create.return_value = SimpleNamespace(url="https://portal.test")
        assert client.post("/api/billing/portal/").data["url"] == "https://portal.test"

    def test_sync_applies_the_live_subscription(self, api, team, fake_client):
        link(team)
        ended = {**stripe_subscription("canceled", sub_id="sub_old"), "created": 5}
        fake_client.v1.subscriptions.list.return_value = SimpleNamespace(data=[ended, stripe_subscription()])
        res = api(team["owner"], team["workspace"]).post("/api/billing/sync/")
        assert res.status_code == 200 and res.data["plan"] == "pro"
        assert res.data["subscription"]["status"] == "active"
        assert res.data["subscription"]["current_period_end"] is not None

    def test_sync_without_account_is_harmless(self, api, team):
        assert api(team["owner"], team["workspace"]).post("/api/billing/sync/").data["plan"] == "free"


class TestWebhook:
    def test_bad_or_missing_signature_changes_nothing(self, api, team, fake_client):
        link(team)
        payload = event("customer.subscription.updated", {"id": "sub_1", "customer": "cus_1"})
        assert webhook(api, payload, secret="whsec_wrong").status_code == 400
        assert api().post("/api/billing/webhook/", json.dumps(payload), content_type="application/json").status_code == 400
        assert api().post("/api/billing/webhook/", "{not json", content_type="application/json").status_code == 400
        team["workspace"].refresh_from_db()
        assert team["workspace"].plan == "free" and not StripeEvent.objects.exists()

    def test_checkout_completed_upgrades_and_audits(self, api, team, fake_client):
        link(team)
        res = webhook(api, event("checkout.session.completed", {"subscription": "sub_1", "customer": "cus_1"}))
        assert res.status_code == 200
        team["workspace"].refresh_from_db()
        assert team["workspace"].plan == "pro"
        entry = AuditLog.objects.get(action="plan_changed")
        assert entry.changes["plan"] == {"from": "free", "to": "pro"} and entry.actor is None

    def test_plan_change_and_cancel_follow_stripe(self, api, team, fake_client):
        link(team)
        fake_client.v1.subscriptions.list.return_value = SimpleNamespace(data=[stripe_subscription(lookup_key="flowboard_enterprise_monthly")])
        webhook(api, event("customer.subscription.updated", {"id": "sub_1", "customer": "cus_1"}, "evt_a"))
        team["workspace"].refresh_from_db()
        assert team["workspace"].plan == "enterprise"
        fake_client.v1.subscriptions.list.return_value = SimpleNamespace(data=[stripe_subscription("canceled")])
        webhook(api, event("customer.subscription.deleted", {"id": "sub_1", "customer": "cus_1"}, "evt_b"))
        team["workspace"].refresh_from_db()
        assert team["workspace"].plan == "free"

    def test_past_due_keeps_the_plan_during_grace(self, api, team, fake_client):
        link(team)
        Workspace.objects.filter(pk=team["workspace"].pk).update(plan="pro")
        fake_client.v1.subscriptions.list.return_value = SimpleNamespace(data=[stripe_subscription("past_due")])
        webhook(api, event("customer.subscription.updated", {"id": "sub_1", "customer": "cus_1"}))
        team["workspace"].refresh_from_db()
        assert team["workspace"].plan == "pro"

    def test_duplicate_event_is_processed_once(self, api, team, fake_client):
        link(team)
        payload = event("customer.subscription.updated", {"id": "sub_1", "customer": "cus_1"})
        assert webhook(api, payload).status_code == 200
        res = webhook(api, payload)
        assert res.status_code == 200 and res.data["duplicate"] is True
        assert fake_client.v1.subscriptions.list.call_count == 1

    def test_stripe_outage_asks_for_a_retry_and_the_retry_works(self, api, team, fake_client):
        link(team)
        payload = event("customer.subscription.updated", {"id": "sub_1", "customer": "cus_1"})
        fake_client.v1.subscriptions.list.side_effect = stripe.APIConnectionError("down")
        assert webhook(api, payload).status_code == 503
        assert not StripeEvent.objects.exists()
        fake_client.v1.subscriptions.list.side_effect = None
        fake_client.v1.subscriptions.list.return_value = SimpleNamespace(data=[stripe_subscription()])
        assert webhook(api, payload).status_code == 200
        team["workspace"].refresh_from_db()
        assert team["workspace"].plan == "pro"

    def test_unknown_customer_and_event_types_are_ignored(self, api, team, fake_client):
        assert webhook(api, event("customer.subscription.updated", {"id": "s", "customer": "cus_other"}, "e1")).status_code == 200
        assert webhook(api, event("balance.available", {}, "e2")).status_code == 200
        fake_client.v1.subscriptions.retrieve.assert_not_called()

    def test_payment_failure_notifies_the_owner(self, api, team, fake_client, monkeypatch):
        from apps.automation.models import Notification

        monkeypatch.setattr("apps.automation.tasks.enqueue", MagicMock(return_value=None))
        link(team)
        assert webhook(api, event("invoice.payment_failed", {"customer": "cus_1"})).status_code == 200
        assert Notification.objects.get(recipient=team["owner"]).title == "Payment failed"


class TestWorkspaceDeletion:
    def test_active_subscription_is_cancelled_first(self, api, team, fake_client):
        link(team, stripe_subscription_id="sub_1", status="active")
        assert api(team["owner"], team["workspace"]).delete("/api/workspace/", {"confirm": team["workspace"].slug, "password": "pass12345"}, format="json").status_code == 204
        fake_client.v1.subscriptions.cancel.assert_called_once_with(
            "sub_1", options={"idempotency_key": f"cancel-deleted-ws-{team['workspace'].pk}"}
        )
        assert not Workspace.objects.filter(pk=team["workspace"].pk).exists()

    def test_stripe_failure_keeps_the_workspace(self, api, team, fake_client):
        link(team, stripe_subscription_id="sub_1", status="active")
        fake_client.v1.subscriptions.cancel.side_effect = stripe.APIConnectionError("down")
        assert api(team["owner"], team["workspace"]).delete("/api/workspace/", {"confirm": team["workspace"].slug, "password": "pass12345"}, format="json").status_code == 503
        assert Workspace.objects.filter(pk=team["workspace"].pk).exists()
