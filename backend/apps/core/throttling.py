"""Throttles keyed by something other than DRF's default (IP for anonymous, user for authenticated)."""
from rest_framework.throttling import SimpleRateThrottle


class UserScopedThrottle(SimpleRateThrottle):
    """Per-user limit for one scope; subclasses set `scope`. Runs after authentication."""

    def get_cache_key(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return None
        return self.cache_format % {"scope": self.scope, "ident": request.user.pk}


class WebhookTestUserThrottle(UserScopedThrottle):
    scope = "webhook_test_user"


class WebhookRedeliverThrottle(UserScopedThrottle):
    scope = "webhook_redeliver"


class ReportCreateThrottle(UserScopedThrottle):
    scope = "report_create"


class WebhookTestEndpointThrottle(SimpleRateThrottle):
    """Per endpoint (within its workspace), whoever is asking."""

    scope = "webhook_test"

    def get_cache_key(self, request, view):
        workspace = getattr(request, "workspace", None)
        endpoint_id = view.kwargs.get("pk")
        if workspace is None or endpoint_id is None:
            return None
        return self.cache_format % {"scope": self.scope, "ident": f"{workspace.pk}:{endpoint_id}"}


class BillingSessionThrottle(UserScopedThrottle):
    """Checkout and portal: each call creates objects in Stripe."""

    scope = "billing_session"


class BillingSyncThrottle(SimpleRateThrottle):
    """Per workspace: any owner tab or device shares the budget."""

    scope = "billing_sync"

    def get_cache_key(self, request, view):
        workspace = getattr(request, "workspace", None)
        if workspace is None:
            return None
        return self.cache_format % {"scope": self.scope, "ident": workspace.pk}
