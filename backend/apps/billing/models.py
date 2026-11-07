from django.db import models

from apps.core.models import TimeStampedModel
from apps.tenants.models import Workspace


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

    def __str__(self):
        return f"{self.workspace} ({self.status or 'no subscription'})"


class StripeEvent(TimeStampedModel):
    """Processed webhook ids. Stripe can deliver an event more than once."""

    event_id = models.CharField(max_length=255, unique=True)
    event_type = models.CharField(max_length=120)

    def __str__(self):
        return self.event_id
