import logging

import stripe
from django.conf import settings
from django.db import IntegrityError, transaction
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.api import WorkspaceScopedMixin
from apps.core.throttling import BillingSessionThrottle, BillingSyncThrottle
from apps.tenants.models import Membership

from . import services
from .limits import usage
from .models import StripeEvent, Subscription
from .plans import PAID_PLANS, PLANS, plan_limits

logger = logging.getLogger(__name__)
Role = Membership.Role
UrlResponse = inline_serializer("BillingRedirect", {"url": serializers.URLField()})


def stripe_call(function, *args):
    """Stripe's own messages can expose account details, so users get a generic one and the logs get the rest."""
    try:
        return function(*args)
    except stripe.StripeError as error:
        logger.exception("Stripe call failed")
        raise services.BillingUnavailable() from error


def over_limit(workspace, current):
    """{resource: {used, limit}} where the workspace is above its plan (e.g. after a downgrade), else null.
    Existing data stays usable; only adding more is blocked. Members count pending invitations, like the check."""
    limits = plan_limits(workspace.plan)
    used = {"projects": current["projects"], "members": current["members"] + current["pending_invitations"]}
    return {
        resource: {"used": used[resource], "limit": limits[resource]}
        if limits[resource] is not None and used[resource] > limits[resource] else None
        for resource in ("projects", "members")
    }


def billing_state(request):
    workspace = request.workspace
    record = Subscription.objects.filter(workspace=workspace).first()
    is_owner = request.membership.role == Role.OWNER
    current = usage(workspace)
    return {
        "plan": workspace.plan,
        "plans": [
            {"id": plan_id, "name": plan["name"], "price_monthly": plan["price_monthly"], "projects": plan["projects"],
             "members": plan["members"], "file_mb": plan["file_mb"], "features": plan["features"]}
            for plan_id, plan in PLANS.items()
        ],
        "usage": current,
        "over_limit": over_limit(workspace, current),
        "can_manage": is_owner,
        "stripe_configured": services.is_configured(),
        "has_billing_account": record is not None,
        "subscription": {
            "status": record.status,
            "current_period_end": record.current_period_end,
            "cancel_at_period_end": record.cancel_at_period_end,
        } if record and record.stripe_subscription_id else None,
    }


class CheckoutSerializer(serializers.Serializer):
    # A plan name only: the server maps it to its own Stripe price, never a price id from the client.
    plan = serializers.ChoiceField(choices=PAID_PLANS)


class BillingView(WorkspaceScopedMixin, APIView):
    """Any member can see the plan and usage. Payment actions are owner-only."""

    @extend_schema(responses=inline_serializer("BillingState", {"plan": serializers.CharField()}))
    def get(self, request):
        return Response(billing_state(request))


class CheckoutView(WorkspaceScopedMixin, APIView):
    required_roles = {"post": Role.OWNER}
    throttle_classes = [BillingSessionThrottle]

    @extend_schema(request=CheckoutSerializer, responses=UrlResponse)
    def post(self, request):
        payload = CheckoutSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        plan = payload.validated_data["plan"]
        return Response({"url": stripe_call(services.create_checkout_url, request.workspace, plan)})


class PortalView(WorkspaceScopedMixin, APIView):
    required_roles = {"post": Role.OWNER}
    throttle_classes = [BillingSessionThrottle]

    @extend_schema(request=None, responses=UrlResponse)
    def post(self, request):
        return Response({"url": stripe_call(services.create_portal_url, request.workspace)})


class SyncView(WorkspaceScopedMixin, APIView):
    required_roles = {"post": Role.OWNER}  # members and viewers never need to trigger a Stripe sync
    throttle_classes = [BillingSyncThrottle]

    @extend_schema(request=None, responses=inline_serializer("BillingSynced", {"plan": serializers.CharField()}))
    def post(self, request):
        request.workspace = stripe_call(services.sync_workspace, request.workspace)
        return Response(billing_state(request))


class StripeWebhookView(APIView):
    """Called by Stripe, so it authenticates by signature instead of a user token.

    Responses: bad signature 400; duplicate, ignored or unknown-customer events 200; Stripe outage 503 and any
    other failure 500, both of which make Stripe retry. The event row and the changes commit together, so a
    failed event leaves no row behind and is processed again on retry."""

    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(exclude=True)
    def post(self, request):
        if not settings.STRIPE_WEBHOOK_SECRET:
            raise services.BillingUnavailable("Webhooks aren't configured.")
        try:
            event = stripe.Webhook.construct_event(
                request.body, request.META.get("HTTP_STRIPE_SIGNATURE", ""), settings.STRIPE_WEBHOOK_SECRET
            )
        except (ValueError, stripe.SignatureVerificationError):
            return Response({"detail": "Invalid signature."}, status=status.HTTP_400_BAD_REQUEST)
        event = services.plain(event)
        event_id, event_type = event.get("id"), event.get("type")
        if StripeEvent.objects.filter(event_id=event_id).exists():
            return Response({"received": True, "duplicate": True})  # skip the Stripe calls for known repeats
        try:
            prepared = services.prepare_event(event)  # Stripe calls happen here, with no transaction open
            with transaction.atomic():
                StripeEvent.objects.create(event_id=event_id, event_type=event_type)
                services.apply_event(event, prepared)
        except IntegrityError:
            return Response({"received": True, "duplicate": True})  # a parallel delivery won the race
        except stripe.StripeError:
            logger.exception("Stripe webhook %s (%s) failed: Stripe unavailable", event_id, event_type)
            return Response({"detail": "Temporary error."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except Exception:
            # Event id and type only: no secrets, customer details or payment data in the log line.
            logger.exception("Stripe webhook %s (%s) failed", event_id, event_type)
            return Response({"detail": "Webhook processing failed."}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        return Response({"received": True})
