import stripe
from celery import shared_task

from . import services


@shared_task(
    name="apps.billing.tasks.update_billing_email",
    autoretry_for=(stripe.StripeError,), retry_backoff=True, retry_backoff_max=600, max_retries=8,
)
def update_billing_email(workspace_id):
    """Queued after an ownership transfer commits. Failures retry here and never roll back the transfer.
    The owner is read when this runs, so an older queued run can't overwrite a newer owner's email."""
    return services.update_customer_email(workspace_id)
