from django.db import models
from django.db.models import Q
from django.db.models.functions import Length
from django.db.models.lookups import GreaterThan

from apps.core.models import TimeStampedModel
from apps.tenants.models import Workspace

from .plans import PAID_PLANS


class Subscription(TimeStampedModel):
    """A workspace's Stripe link. `Workspace.plan` stays the single value that limits read."""

    workspace = models.OneToOneField(Workspace, on_delete=models.CASCADE, related_name="subscription")
    stripe_customer_id = models.CharField(max_length=64, unique=True)
    stripe_subscription_id = models.CharField(max_length=64, blank=True)
    status = models.CharField(max_length=32, blank=True)
    current_period_end = models.DateTimeField(null=True, blank=True)
    cancel_at_period_end = models.BooleanField(default=False)
    # The last Checkout Session we opened, so a second click reuses it instead of opening a second purchase.
    checkout_session_id = models.CharField(max_length=255, blank=True)
    checkout_plan = models.CharField(max_length=20, blank=True)
    # When the Stripe fetch behind the last applied snapshot *started*. Webhook and sync take this timestamp
    # before calling Stripe and compare it after locking, so a request that started earlier but finished
    # later can't overwrite newer state.
    synced_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            # One Stripe subscription pays for one workspace. Empty = no subscription yet (many rows).
            models.UniqueConstraint(fields=["stripe_subscription_id"], condition=~Q(stripe_subscription_id=""),
                                    name="uq_subscription_stripe_id"),
            # Status and subscription id come and go together (a cancelled one keeps its id). status itself
            # stays free text on purpose: a new Stripe status must never make a webhook write fail.
            models.CheckConstraint(condition=Q(status="", stripe_subscription_id="")
                                   | (~Q(status="") & ~Q(stripe_subscription_id="")),
                                   name="ck_subscription_status_has_id"),
            # The paid plans of the catalogue (a test keeps this in step with apps.billing.plans).
            models.CheckConstraint(condition=Q(checkout_plan__in=["", *PAID_PLANS]), name="ck_subscription_checkout_plan"),
        ]

    def __str__(self):
        return f"{self.workspace} ({self.status or 'no subscription'})"


class StripeEvent(models.Model):
    """Processed webhook ids. Stripe can deliver an event more than once. Rows are never updated,
    so there is only a creation time (used by the retention purge)."""

    created_at = models.DateTimeField(auto_now_add=True)

    event_id = models.CharField(max_length=255, unique=True)
    event_type = models.CharField(max_length=120)

    class Meta:
        constraints = [models.CheckConstraint(condition=GreaterThan(Length("event_id"), 0), name="ck_stripeevent_id_not_empty")]
        # Nightly retention deletes by age, in batches.
        indexes = [models.Index(fields=["created_at"], name="stripeevent_created")]

    def __str__(self):
        return self.event_id
