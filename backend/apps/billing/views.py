import logging

import stripe
from django.conf import settings
from django.db import IntegrityError, transaction
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import exceptions, serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.api import WorkspaceScopedMixin
from apps.tenants.models import Membership

from . import services
from .limits import usage
from .models import StripeEvent, Subscription
from .plans import PAID_PLANS, PLANS

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


def billing_state(request):
    workspace = request.workspace
    record = Subscription.objects.filter(workspace=workspace).first()
    is_owner = request.membership.role == Role.OWNER
    return {
        "plan": workspace.plan,
        "plans": [
            {"id": plan_id, "name": plan["name"], "price_monthly": plan["price_monthly"], "projects": plan["projects"],
             "members": plan["members"], "file_mb": plan["file_mb"], "features": plan["features"]}
            for plan_id, plan in PLANS.items()
        ],
        "usage": usage(workspace),
        "can_manage": is_owner,
        "stripe_configured": services.is_configured(),
        "has_billing_account": record is not None,
        "subscription": {
            "status": record.status,
            "current_period_end": record.current_period_end,
            "cancel_at_period_end": record.cancel_at_period_end,
        } if record and record.stripe_subscription_id else None,
    }


class BillingView(WorkspaceScopedMixin, APIView):
    """Any member can see the plan and usage. Payment actions are owner-only."""

    @extend_schema(responses=inline_serializer("BillingState", {"plan": serializers.CharField()}))
    def get(self, request):
        return Response(billing_state(request))


class CheckoutView(WorkspaceScopedMixin, APIView):
    required_roles = {"post": Role.OWNER}

    @extend_schema(request=inline_serializer("Checkout", {"plan": serializers.ChoiceField(PAID_PLANS)}), responses=UrlResponse)
    def post(self, request):
        plan = request.data.get("plan") if isinstance(request.data, dict) else None
        if not isinstance(plan, str) or plan not in PAID_PLANS:
            raise exceptions.ValidationError({"plan": "Choose a paid plan."})
        record = Subscription.objects.filter(workspace=request.workspace).first()
        if record and record.status in services.PAID_STATUSES:
            raise exceptions.ValidationError("This workspace already has a subscription. Use Manage billing to change it.")
        return Response({"url": stripe_call(services.create_checkout_url, request.workspace, plan)})


class PortalView(WorkspaceScopedMixin, APIView):
    required_roles = {"post": Role.OWNER}

    @extend_schema(request=None, responses=UrlResponse)
    def post(self, request):
        return Response({"url": stripe_call(services.create_portal_url, request.workspace)})


class SyncView(WorkspaceScopedMixin, APIView):
    required_roles = {"post": Role.OWNER}

    @extend_schema(request=None, responses=inline_serializer("BillingSynced", {"plan": serializers.CharField()}))
    def post(self, request):
        request.workspace = stripe_call(services.sync_workspace, request.workspace)
        return Response(billing_state(request))


class StripeWebhookView(APIView):
    """Called by Stripe, so it authenticates by signature instead of a user token."""

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
        try:
            # The id and the work commit together, so a failed event is retried and a repeated one is skipped.
            with transaction.atomic():
                StripeEvent.objects.create(event_id=event["id"], event_type=event["type"])
                services.handle_event(event)
        except IntegrityError:
            return Response({"received": True, "duplicate": True})
        except stripe.StripeError:
            logger.exception("Stripe webhook %s failed", event["id"])
            return Response({"detail": "Temporary error."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({"received": True})
