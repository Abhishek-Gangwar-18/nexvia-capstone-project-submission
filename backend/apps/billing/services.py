"""Everything that talks to Stripe. Prices are found by lookup key, so ids never live in code."""
from datetime import datetime, timezone as dt_timezone

import stripe
from django.conf import settings
from django.db import transaction
from rest_framework import exceptions, status

from apps.automation.tasks import notify
from apps.issues.activity import record_event
from apps.issues.models import AuditLog
from apps.tenants.models import Membership, Workspace

from .models import Subscription
from .plans import PLAN_BY_LOOKUP_KEY, PLANS

# Stripe statuses that keep the paid plan. past_due is a grace period while Stripe retries the card.
PAID_STATUSES = {"active", "trialing", "past_due"}
ENDED_STATUSES = {"canceled", "unpaid", "incomplete_expired"}


class BillingUnavailable(exceptions.APIException):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = "Billing isn't available right now. Please try again shortly."


def is_configured():
    return bool(settings.STRIPE_SECRET_KEY)


def client():
    if not is_configured():
        raise BillingUnavailable("Billing isn't configured: STRIPE_SECRET_KEY is missing.")
    return stripe.StripeClient(settings.STRIPE_SECRET_KEY, max_network_retries=2)


def plain(obj):
    return obj.to_dict() if hasattr(obj, "to_dict") else obj


def price_id_for(stripe_client, plan_id):
    lookup_key = PLANS[plan_id]["lookup_key"]
    prices = stripe_client.v1.prices.list(params={"lookup_keys": [lookup_key], "active": True, "limit": 1})
    if not prices.data:
        raise BillingUnavailable("Billing prices aren't set up yet. Run: python manage.py stripe_setup")
    return prices.data[0].id


def get_or_create_customer(stripe_client, workspace):
    existing = Subscription.objects.filter(workspace=workspace).first()
    if existing:
        return existing
    customer = stripe_client.v1.customers.create(params={
        "name": workspace.name,
        "email": workspace.owner.email,
        "metadata": {"workspace_id": str(workspace.pk), "workspace_slug": workspace.slug},
    })
    return Subscription.objects.create(workspace=workspace, stripe_customer_id=customer.id)


def create_checkout_url(workspace, plan_id):
    stripe_client = client()
    subscription = get_or_create_customer(stripe_client, workspace)
    base = f"{settings.FRONTEND_URL.rstrip('/')}/w/{workspace.slug}/billing"
    session = stripe_client.v1.checkout.sessions.create(params={
        "mode": "subscription",
        "customer": subscription.stripe_customer_id,
        "line_items": [{"price": price_id_for(stripe_client, plan_id), "quantity": 1}],
        "subscription_data": {"metadata": {"workspace_id": str(workspace.pk)}},
        "success_url": f"{base}?checkout=success",
        "cancel_url": f"{base}?checkout=cancelled",
    })
    return session.url


def create_portal_url(workspace):
    subscription = Subscription.objects.filter(workspace=workspace).first()
    if subscription is None:
        raise exceptions.ValidationError("This workspace has no billing account yet.")
    session = client().v1.billing_portal.sessions.create(params={
        "customer": subscription.stripe_customer_id,
        "return_url": f"{settings.FRONTEND_URL.rstrip('/')}/w/{workspace.slug}/billing?checkout=portal",
    })
    return session.url


def _plan_from_subscription(data):
    for item in data.get("items", {}).get("data", []):
        plan_id = PLAN_BY_LOOKUP_KEY.get((item.get("price") or {}).get("lookup_key"))
        if plan_id:
            return plan_id
    return None


def _period_end(data):
    # Newer Stripe API versions report the period on each item instead of on the subscription.
    items = data.get("items", {}).get("data", [])
    value = data.get("current_period_end") or (items[0].get("current_period_end") if items else None)
    return datetime.fromtimestamp(value, tz=dt_timezone.utc) if value else None


@transaction.atomic
def apply_subscription(record, data):
    """Copy a Stripe subscription onto our records and move the workspace to the plan it pays for."""
    record.stripe_subscription_id = data["id"]
    record.status = data.get("status", "")
    record.current_period_end = _period_end(data)
    record.cancel_at_period_end = bool(data.get("cancel_at_period_end") or data.get("cancel_at"))
    record.save()

    workspace = Workspace.objects.select_for_update().get(pk=record.workspace_id)
    new_plan = workspace.plan
    if record.status in PAID_STATUSES:
        new_plan = _plan_from_subscription(data) or workspace.plan
    elif record.status in ENDED_STATUSES:
        new_plan = Workspace.Plan.FREE
    if new_plan != workspace.plan:
        old_plan, workspace.plan = workspace.plan, new_plan
        workspace.save(update_fields=["plan", "updated_at"])
        record_event(workspace, None, AuditLog.Action.PLAN_CHANGED, AuditLog.Entity.BILLING, workspace.name,
                     changes={"plan": {"from": old_plan, "to": new_plan}, "stripe_status": record.status})
    return workspace


def _retrieve(stripe_client, subscription_id):
    return plain(stripe_client.v1.subscriptions.retrieve(subscription_id, params={"expand": ["items.data.price"]}))


def sync_workspace(workspace):
    """Read the current state from Stripe. This makes billing work even when webhooks can't reach the machine."""
    record = Subscription.objects.filter(workspace=workspace).first()
    if record is None:
        return workspace
    stripe_client = client()
    subscriptions = stripe_client.v1.subscriptions.list(
        params={"customer": record.stripe_customer_id, "status": "all", "limit": 10, "expand": ["data.items.data.price"]}
    ).data
    rows = sorted((plain(s) for s in subscriptions), key=lambda s: s.get("created", 0), reverse=True)
    live = [s for s in rows if s.get("status") not in ENDED_STATUSES]
    chosen = (live or rows or [None])[0]
    return apply_subscription(record, chosen) if chosen else workspace


def handle_event(event):
    """Handle a verified webhook event. Unknown types are ignored; a raised error makes Stripe retry later."""
    event_type = event["type"]
    data = event["data"]["object"]
    if event_type == "checkout.session.completed":
        subscription_id, customer_id = data.get("subscription"), data.get("customer")
    elif event_type.startswith("customer.subscription."):
        subscription_id, customer_id = data.get("id"), data.get("customer")
    elif event_type == "invoice.payment_failed":
        _notify_payment_failed(event["id"], data.get("customer"))
        return
    else:
        return
    if not subscription_id:
        return
    record = Subscription.objects.filter(stripe_customer_id=customer_id).first()
    if record is None:
        return  # another environment sharing this Stripe account
    # Always re-read from Stripe: events can arrive out of order, the API can't be stale.
    apply_subscription(record, _retrieve(client(), subscription_id))


def _notify_payment_failed(event_id, customer_id):
    record = Subscription.objects.select_related("workspace").filter(stripe_customer_id=customer_id).first()
    if record is None:
        return
    workspace = record.workspace
    owner_is_member = Membership.objects.filter(workspace=workspace, user_id=workspace.owner_id).exists()
    if owner_is_member:
        notify(
            workspace, workspace.owner_id, f"billing:{event_id}", email=True,
            title="Payment failed", body=f"We couldn't charge the card for {workspace.name}. Update it to keep your plan.",
            url=f"/w/{workspace.slug}/billing",
        )


def cancel_for_deleted_workspace(workspace):
    """Stop charging before a workspace is deleted. A Stripe error blocks the delete instead of leaving a live charge."""
    record = Subscription.objects.filter(workspace=workspace).exclude(stripe_subscription_id="").first()
    if record and record.status not in ENDED_STATUSES:
        try:
            client().v1.subscriptions.cancel(record.stripe_subscription_id)
        except stripe.InvalidRequestError:
            pass  # already gone in Stripe
        except stripe.StripeError as error:
            raise BillingUnavailable("Couldn't cancel the subscription, so the workspace was not deleted.") from error

