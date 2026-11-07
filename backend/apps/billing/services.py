"""Everything that talks to Stripe. Prices are found by lookup key, so ids never live in code.

Concurrency rules (see each function for details):
  * Checkout and customer creation take a per-workspace *advisory* lock for the whole operation, including
    the Stripe calls, so two tabs can't both open a purchase. It is not the workspace row lock, so it never
    blocks project creation, invites or other workspace writes.
  * Webhooks and sync fetch from Stripe first, with no transaction open, then apply the snapshot in one
    short transaction that locks the workspace row, then the subscription row (always in that order).
  * A snapshot whose Stripe fetch *started* before the one already applied is discarded (Subscription.synced_at).
    This orders overlapping requests; it isn't a Stripe event version, so sync stays available to reconcile.
"""
import logging
import time
from datetime import datetime, timezone as dt_timezone

import stripe
from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from rest_framework import exceptions, status

from apps.automation.tasks import notify
from apps.issues.activity import record_event
from apps.issues.models import AuditLog
from apps.tenants.models import Membership, Workspace

from .models import Subscription
from .plans import PLAN_BY_LOOKUP_KEY, PLANS

logger = logging.getLogger(__name__)

# Stripe statuses that keep the paid plan. past_due is a grace period while Stripe retries the card.
PAID_STATUSES = {"active", "trialing", "past_due"}
ENDED_STATUSES = {"canceled", "unpaid", "incomplete_expired"}
BILLING_LOCK_CLASS = 7301  # namespace for pg_advisory_xact_lock(class, workspace_id)
CHECKOUT_KEY_WINDOW = 600  # seconds: identical checkout requests in this window share one idempotency key
SESSION_MIN_REMAINING = 120  # seconds: don't hand out an open session that's about to expire


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


def _field(obj, name, default=None):
    obj = plain(obj)
    return obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)


def billing_lock(workspace_id):
    """Serialize billing operations of one workspace. Must run inside transaction.atomic()."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s, %s)", [BILLING_LOCK_CLASS, workspace_id])


def price_id_for(stripe_client, plan_id):
    """Plans map to prices on the server; a price id is never taken from the client."""
    lookup_key = PLANS[plan_id]["lookup_key"]
    prices = stripe_client.v1.prices.list(params={"lookup_keys": [lookup_key], "active": True, "limit": 1})
    if not prices.data:
        raise BillingUnavailable("Billing prices aren't set up yet. Run: python manage.py stripe_setup")
    return prices.data[0].id


def get_or_create_customer(stripe_client, workspace):
    """Call under billing_lock. Stripe and our DB can't share a transaction, so: a stable idempotency key
    makes a repeated create return the same Stripe customer, and if saving fails we log the id for repair."""
    existing = Subscription.objects.filter(workspace=workspace).first()
    if existing:
        return existing
    customer = stripe_client.v1.customers.create(
        params={
            "name": workspace.name,
            "email": workspace.owner.email,
            "metadata": {"workspace_id": str(workspace.pk), "workspace_slug": workspace.slug},
        },
        options={"idempotency_key": f"customer-ws-{workspace.pk}"},
    )
    try:
        with transaction.atomic():
            return Subscription.objects.create(workspace=workspace, stripe_customer_id=customer.id)
    except IntegrityError:
        existing = Subscription.objects.filter(workspace=workspace).first()
        if existing:
            return existing
        logger.error("Stripe customer %s for workspace %s was created but could not be saved", customer.id, workspace.pk)
        raise


def create_checkout_url(workspace, plan_id):
    stripe_client = client()
    with transaction.atomic():
        billing_lock(workspace.pk)
        record = get_or_create_customer(stripe_client, workspace)
        record.refresh_from_db()
        if record.status in PAID_STATUSES:  # re-checked under the lock
            raise exceptions.ValidationError("This workspace already has a subscription. Use Manage billing to change it.")
        reusable = _open_session(stripe_client, record, plan_id)
        if reusable:
            return reusable
        base = f"{settings.FRONTEND_URL.rstrip('/')}/w/{workspace.slug}/billing"
        window = int(time.time() // CHECKOUT_KEY_WINDOW)
        session = stripe_client.v1.checkout.sessions.create(
            params={
                "mode": "subscription",
                "customer": record.stripe_customer_id,
                "line_items": [{"price": price_id_for(stripe_client, plan_id), "quantity": 1}],
                "subscription_data": {"metadata": {"workspace_id": str(workspace.pk)}},
                "success_url": f"{base}?checkout=success",
                "cancel_url": f"{base}?checkout=cancelled",
            },
            options={"idempotency_key": f"checkout-ws-{workspace.pk}-{plan_id}-{window}"},
        )
        record.checkout_session_id = _field(session, "id", "") or ""
        record.checkout_plan = plan_id
        record.save(update_fields=["checkout_session_id", "checkout_plan", "updated_at"])
        return _field(session, "url")


def _open_session(stripe_client, record, plan_id):
    """The URL of our last session for this plan if Stripe says it's still open; never an expired or
    completed one. Asks Stripe, because our own status can't know whether a session was completed."""
    if not record.checkout_session_id or record.checkout_plan != plan_id:
        return None
    try:
        session = plain(stripe_client.v1.checkout.sessions.retrieve(record.checkout_session_id))
    except stripe.InvalidRequestError:
        return None
    if not isinstance(session, dict) or session.get("status") != "open":
        return None
    if (session.get("expires_at") or 0) < time.time() + SESSION_MIN_REMAINING:
        return None
    return session.get("url")


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
        price = item.get("price") or {}
        plan_id = PLAN_BY_LOOKUP_KEY.get(price.get("lookup_key"))
        if plan_id:
            return plan_id
    return None


def _period_end(data):
    # Newer Stripe API versions report the period on each item instead of on the subscription.
    items = data.get("items", {}).get("data", [])
    value = data.get("current_period_end") or (items[0].get("current_period_end") if items else None)
    return datetime.fromtimestamp(value, tz=dt_timezone.utc) if value else None


def fetch_canonical(stripe_client, record):
    """Read every subscription of the customer from Stripe and pick the one that counts. If more than one is
    live (e.g. two checkouts were both completed), keep the oldest and cancel the rest. Runs with no DB
    transaction open. A failed cancel raises, so the webhook asks Stripe to retry (keys make it idempotent).
    Cancelling doesn't refund: the duplicate charge is logged and audited for a manual refund."""
    rows = [plain(s) for s in stripe_client.v1.subscriptions.list(
        params={"customer": record.stripe_customer_id, "status": "all", "limit": 20, "expand": ["data.items.data.price"]}
    ).data]
    live = sorted((s for s in rows if s.get("status") not in ENDED_STATUSES), key=lambda s: (s.get("created", 0), s["id"]))
    if len(live) > 1:
        canonical, extras = live[0], live[1:]
        detected_at = timezone.now().isoformat()
        for extra in extras:
            result = "cancelled"
            try:
                stripe_client.v1.subscriptions.cancel(extra["id"], options={"idempotency_key": f"cancel-duplicate-{extra['id']}"})
            except stripe.StripeError as error:
                result = f"cancel failed: {type(error).__name__}"  # recorded, then re-raised so Stripe retries
                raise
            finally:
                _record_duplicate(record, canonical["id"], extra["id"], detected_at, result)
        return canonical
    if live:
        return live[0]
    return max(rows, key=lambda s: s.get("created", 0)) if rows else None


def _record_duplicate(record, kept_id, cancelled_id, detected_at, result):
    """One audit entry and one log line per duplicate. Cancelling stops future charges only: nothing is
    refunded, so every entry is flagged for a manual refund review."""
    details = {
        "workspace_id": record.workspace_id,
        "retained_subscription": kept_id,
        "cancelled_subscription": cancelled_id,
        "detected_at": detected_at,
        "cancellation_result": result,
        "refund_issued": False,
        "manual_refund_review_required": True,
    }
    logger.warning("Duplicate Stripe subscription for customer %s: %s", record.stripe_customer_id, details)
    record_event(record.workspace, None, AuditLog.Action.UPDATED, AuditLog.Entity.BILLING, record.workspace.name,
                 changes={"duplicate_subscription": details})


def apply_subscription(record_id, data, fetch_started_at):
    """Copy a Stripe snapshot onto our records and move the workspace to the plan it pays for.
    Lock order: workspace row, then subscription row (same everywhere, so no deadlocks)."""
    with transaction.atomic():
        workspace_id = Subscription.objects.values_list("workspace_id", flat=True).get(pk=record_id)
        workspace = Workspace.objects.select_for_update().get(pk=workspace_id)
        record = Subscription.objects.select_for_update().get(pk=record_id)
        # Compare fetch *start* times: a request that began earlier can finish later, and must not win.
        if record.synced_at and record.synced_at > fetch_started_at:
            logger.info("Skipped a stale Stripe snapshot for %s (its fetch started %s; applied one started %s)",
                        record.pk, fetch_started_at, record.synced_at)
            return workspace
        record.stripe_subscription_id = data["id"]
        record.status = data.get("status", "")
        record.current_period_end = _period_end(data)
        record.cancel_at_period_end = bool(data.get("cancel_at_period_end") or data.get("cancel_at"))
        record.synced_at = fetch_started_at
        record.save()

        new_plan = workspace.plan
        if record.status in PAID_STATUSES:
            paid_plan = _plan_from_subscription(data)
            if paid_plan is None:
                prices = [((i.get("price") or {}).get("id"), (i.get("price") or {}).get("lookup_key"))
                          for i in data.get("items", {}).get("data", [])]
                logger.warning("Subscription %s pays for unknown prices %s; plan left at %s",
                               data["id"], prices, workspace.plan)
            else:
                new_plan = paid_plan
        elif record.status in ENDED_STATUSES:
            new_plan = Workspace.Plan.FREE
        if new_plan != workspace.plan:
            old_plan, workspace.plan = workspace.plan, new_plan
            workspace.save(update_fields=["plan", "updated_at"])
            record_event(workspace, None, AuditLog.Action.PLAN_CHANGED, AuditLog.Entity.BILLING, workspace.name,
                         changes={"plan": {"from": old_plan, "to": new_plan}, "stripe_status": record.status})
        return workspace


def sync_workspace(workspace):
    """Read the current state from Stripe. This makes billing work even when webhooks can't reach the machine."""
    record = Subscription.objects.select_related("workspace").filter(workspace=workspace).first()
    if record is None:
        return workspace
    fetch_started_at = timezone.now()  # taken before the Stripe call, never after it
    chosen = fetch_canonical(client(), record)
    return apply_subscription(record.pk, chosen, fetch_started_at) if chosen else workspace


def event_customer(event):
    """(kind, customer id) for events we act on, or (None, None) for everything else."""
    event_type, data = event["type"], event["data"]["object"]
    if event_type == "checkout.session.completed" or event_type.startswith("customer.subscription."):
        return "subscription", data.get("customer")
    if event_type == "invoice.payment_failed":
        return "payment_failed", data.get("customer")
    return None, None


def prepare_event(event):
    """Everything that talks to Stripe, done before the DB transaction opens. Returns what apply needs."""
    kind, customer_id = event_customer(event)
    if kind != "subscription":
        return {"kind": kind, "customer_id": customer_id}
    record = Subscription.objects.select_related("workspace").filter(stripe_customer_id=customer_id).first()
    if record is None:
        return {"kind": None}  # another environment sharing this Stripe account
    fetch_started_at = timezone.now()  # taken before the Stripe call, never after it
    # Always re-read from Stripe: events can arrive out of order, the current state can't be stale.
    snapshot = fetch_canonical(client(), record)
    return {"kind": kind, "record_id": record.pk, "snapshot": snapshot, "fetch_started_at": fetch_started_at}


def apply_event(event, prepared):
    """Runs inside the webhook's transaction, right after the StripeEvent row is recorded."""
    if prepared["kind"] == "subscription" and prepared.get("snapshot"):
        apply_subscription(prepared["record_id"], prepared["snapshot"], prepared["fetch_started_at"])
    elif prepared["kind"] == "payment_failed":
        _notify_payment_failed(event["id"], prepared["customer_id"])


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


def update_customer_email(workspace_id):
    """Point the Stripe customer at the workspace's *current* owner. Reads the owner when it runs, so an
    older queued task can't write a previous owner's address over a newer one."""
    record = Subscription.objects.select_related("workspace__owner").filter(workspace_id=workspace_id).first()
    if record is None or not is_configured():
        return None
    email = record.workspace.owner.email
    client().v1.customers.update(record.stripe_customer_id, params={"email": email})
    return email


def cancel_for_deleted_workspace(workspace):
    """Stop charging before a workspace is deleted. A Stripe error blocks the delete instead of leaving a live
    charge. The local status is saved right away (outside the delete), so if the delete then fails, the retry
    sees the subscription as already cancelled and doesn't call Stripe again."""
    record = Subscription.objects.filter(workspace=workspace).exclude(stripe_subscription_id="").first()
    if record and record.status not in ENDED_STATUSES:
        try:
            client().v1.subscriptions.cancel(
                record.stripe_subscription_id, options={"idempotency_key": f"cancel-deleted-ws-{workspace.pk}"}
            )
        except stripe.InvalidRequestError:
            pass  # already gone in Stripe
        except stripe.StripeError as error:
            raise BillingUnavailable("Couldn't cancel the subscription, so the workspace was not deleted.") from error
        Subscription.objects.filter(pk=record.pk).update(status="canceled", updated_at=timezone.now())
