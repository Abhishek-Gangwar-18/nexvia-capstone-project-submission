import secrets

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

from apps.core.models import TenantModel
from apps.tenants.models import Membership


def generate_webhook_secret():
    return secrets.token_hex(32)


class WebhookEndpoint(TenantModel):
    name = models.CharField(max_length=100)
    url = models.URLField(max_length=500)
    secret = models.CharField(max_length=64, default=generate_webhook_secret)
    events = models.JSONField(default=list)
    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="webhook_endpoints")

    class Meta:
        ordering = ["name", "id"]

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        if self.created_by_id and not Membership.objects.filter(workspace_id=self.workspace_id, user_id=self.created_by_id).exists():
            raise ValidationError({"created_by": "Creator is not a workspace member."})


class WebhookDelivery(TenantModel):
    class State(models.TextChoices):
        PENDING = "pending", "Pending"
        DELIVERED = "delivered", "Delivered"
        FAILED = "failed", "Failed"

    endpoint = models.ForeignKey(WebhookEndpoint, on_delete=models.CASCADE, related_name="deliveries")
    event_id = models.UUIDField()
    event = models.CharField(max_length=80)
    payload = models.JSONField()
    state = models.CharField(max_length=12, choices=State.choices, default=State.PENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    response_status = models.PositiveSmallIntegerField(null=True, blank=True)
    response_body = models.TextField(blank=True)
    last_error = models.TextField(blank=True)
    next_attempt_at = models.DateTimeField(null=True, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [models.UniqueConstraint(fields=["endpoint", "event_id"], name="unique_webhook_event_delivery")]


class Notification(TenantModel):
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="flowboard_notifications")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="flowboard_actions")
    event_key = models.CharField(max_length=180)
    title = models.CharField(max_length=180)
    body = models.CharField(max_length=500)
    url = models.CharField(max_length=500, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [models.UniqueConstraint(fields=["workspace", "recipient", "event_key"], name="unique_workspace_notification_event")]
        indexes = [models.Index(fields=["workspace", "recipient", "read_at"])]

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        members = Membership.objects.filter(workspace_id=self.workspace_id)
        if not members.filter(user_id=self.recipient_id).exists():
            raise ValidationError({"recipient": "Recipient is not a workspace member."})
        if self.actor_id and not members.filter(user_id=self.actor_id).exists():
            raise ValidationError({"actor": "Actor is not a workspace member."})


class WorkspaceReport(TenantModel):
    class State(models.TextChoices):
        PENDING = "pending", "Pending"
        READY = "ready", "Ready"
        FAILED = "failed", "Failed"

    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="flowboard_reports")
    report_type = models.CharField(max_length=30, default="workspace_summary")
    state = models.CharField(max_length=10, choices=State.choices, default=State.PENDING)
    data = models.JSONField(default=dict)
    error = models.CharField(max_length=500, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        if not Membership.objects.filter(workspace_id=self.workspace_id, user_id=self.requested_by_id).exists():
            raise ValidationError({"requested_by": "Requester is not a workspace member."})
