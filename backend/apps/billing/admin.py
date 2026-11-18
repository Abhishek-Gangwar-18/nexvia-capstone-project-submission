from django.contrib import admin

from .models import StripeEvent, Subscription


@admin.register(Subscription)
class SubscriptionAdmin(admin.ModelAdmin):
    list_display = ["workspace", "status", "current_period_end", "cancel_at_period_end"]
    list_filter = ["status"]
    search_fields = ["workspace__name", "stripe_customer_id", "stripe_subscription_id"]


@admin.register(StripeEvent)
class StripeEventAdmin(admin.ModelAdmin):
    list_display = ["event_id", "event_type", "created_at"]
    search_fields = ["event_id", "event_type"]

    # Idempotency records: deleting one re-arms the event (Stripe's next retry would apply it again), editing
    # one breaks idempotency for two ids. Viewable and searchable only.
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
