"""Create FlowBoard's products, prices and portal settings in Stripe. Safe to run again. Test keys only."""
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.billing.plans import PLANS
from apps.billing.services import client


class Command(BaseCommand):
    help = "Create Stripe test-mode products, prices and customer portal configuration."

    def handle(self, *args, **options):
        if not settings.STRIPE_SECRET_KEY.startswith("sk_test_"):
            raise CommandError("Refusing to run: STRIPE_SECRET_KEY must be a test key (sk_test_...).")
        stripe_client = client()
        portal_products = []
        for plan in PLANS.values():
            if not plan["lookup_key"]:
                continue
            found = stripe_client.v1.prices.list(params={"lookup_keys": [plan["lookup_key"]], "active": True, "limit": 1}).data
            if found:
                price = found[0]
                self.stdout.write(f"  = {plan['name']}: price already exists")
            else:
                product = stripe_client.v1.products.create(params={
                    "name": f"FlowBoard {plan['name']}", "metadata": {"app": "flowboard"},
                })
                price = stripe_client.v1.prices.create(params={
                    "product": product.id, "currency": "usd", "unit_amount": plan["price_monthly"] * 100,
                    "recurring": {"interval": "month"}, "lookup_key": plan["lookup_key"],
                })
                self.stdout.write(self.style.SUCCESS(f"  + {plan['name']}: created at ${plan['price_monthly']}/month"))
            portal_products.append({"product": price.product, "prices": [price.id]})

        configurations = stripe_client.v1.billing_portal.configurations.list(params={"is_default": True, "limit": 1}).data
        if configurations:
            self.stdout.write("  = Customer portal: already configured")
        else:
            stripe_client.v1.billing_portal.configurations.create(params={
                "business_profile": {"headline": "FlowBoard billing"},
                "features": {
                    "invoice_history": {"enabled": True},
                    "payment_method_update": {"enabled": True},
                    "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
                    "subscription_update": {
                        "enabled": True, "default_allowed_updates": ["price"], "products": portal_products,
                        "proration_behavior": "create_prorations",
                    },
                },
            })
            self.stdout.write(self.style.SUCCESS("  + Customer portal: configured"))
