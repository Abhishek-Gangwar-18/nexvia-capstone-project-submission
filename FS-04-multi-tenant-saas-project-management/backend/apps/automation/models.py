import secrets

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import F, Q
from django.db.models.functions import Length, Trim
from django.db.models.lookups import GreaterThan

from apps.core.models import TenantModel, choices_check, workspace_fk_without_index
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
    # Final (non-retried) delivery failures in a row; a success resets it. Total history is in deliveries.
    consecutive_failures = models.PositiveIntegerField(default=0)
    disabled_at = models.DateTimeField(null=True, blank=True)
    disabled_reason = models.CharField(max_length=200, blank=True)

    @property
    def secret_hint(self):
        return f"\u2022\u2022\u2022\u2022{self.secret[-4:]}" if self.secret else ""

    class Meta:
        ordering = ["name", "id"]
        constraints = [
            models.CheckConstraint(condition=GreaterThan(Length(Trim("name")), 0), name="ck_webhook_name_not_blank"),
            # disabled_at / disabled_reason record an AUTOMATIC disable; an active endpoint can't carry one. (A
            # manual disable leaves them empty, so is_active=false alone stays valid.)
            models.CheckConstraint(
                condition=Q(is_active=False) | (Q(disabled_at__isnull=True) & Q(disabled_reason="")),
                name="ck_webhook_active_not_disabled",
            ),
            # events must be a JSON array (raw CHECK in automation migration 0009: jsonb_typeof isn't expressible
            # here); the allowed names are the serializer's job, since they change with features.
        ]

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        if self._state.adding and self.created_by_id and not Membership.objects.filter(workspace_id=self.workspace_id, user_id=self.created_by_id).exists():
            raise ValidationError({"created_by": "Creator is not a workspace member."})



class WebhookDeliveryState(models.TextChoices):
    PENDING = "pending", "Pending"
    PROCESSING = "processing", "Processing"
    DELIVERED = "delivered", "Delivered"
    FAILED = "failed", "Failed"


class WebhookDelivery(TenantModel):
    State = WebhookDeliveryState

    # delivery_endpoint_newest (endpoint, -created_at, -id) serves the endpoint filter and the cascade.
    endpoint = models.ForeignKey(WebhookEndpoint, on_delete=models.CASCADE, related_name="deliveries", db_index=False)
    # Manual redeliveries are new rows pointing at the original, so history is never overwritten.
    redelivery_of = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="redeliveries")
    # Fixed at creation (a DB trigger rejects changes). The unique index below keys on THIS, not on
    # redelivery_of: deleting an original (retention, workspace purge) sets redelivery_of to NULL on its
    # redeliveries, which used to turn them into "originals" and collide on (endpoint, event_id).
    is_redelivery = models.BooleanField(default=False, editable=False)
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
    # Worker lease: a claimed row is PROCESSING until lease_expires_at; after that another worker may reclaim it.
    claimed_at = models.DateTimeField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    claim_token = models.CharField(max_length=64, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            # One original delivery per event and endpoint; redeliveries reuse the event_id on purpose.
            models.UniqueConstraint(
                fields=["endpoint", "event_id"], condition=Q(is_redelivery=False), name="unique_webhook_event_delivery"
            ),
            models.CheckConstraint(condition=Q(redelivery_of__isnull=True) | Q(is_redelivery=True),
                                   name="ck_delivery_redelivery_flag"),
            choices_check("state", WebhookDeliveryState.choices, "ck_delivery_state"),
            models.CheckConstraint(condition=~Q(state="delivered") | Q(delivered_at__isnull=False),
                                   name="ck_delivery_delivered_at"),
            models.CheckConstraint(
                condition=~Q(state="processing") | (Q(claimed_at__isnull=False) & Q(lease_expires_at__isnull=False)),
                name="ck_delivery_processing_lease",
            ),
            models.CheckConstraint(condition=~Q(state__in=["delivered", "failed"]) | Q(lease_expires_at__isnull=True),
                                   name="ck_delivery_finished_no_lease"),
        ]
        indexes = [
            # The per-endpoint history, newest first: reads only the rows returned.
            models.Index(F("endpoint"), F("created_at").desc(), F("id").desc(), name="delivery_endpoint_newest"),
            # Nightly retention scans finished rows by age only.
            models.Index(fields=["created_at"], condition=Q(state__in=["delivered", "failed"]),
                         name="delivery_finished_created"),
            # Stalled-lease recovery: only the (few) rows being processed.
            models.Index(fields=["lease_expires_at"], condition=Q(state="processing"), name="delivery_processing_lease"),
        ]


class Notification(TenantModel):
    # Composite indexes below start with workspace_id, so a separate single-column index is redundant
    # (benchmarked at 100k rows: the planner uses the composite at equal or better speed).
    workspace = workspace_fk_without_index()
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="flowboard_notifications")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="flowboard_actions")
    event_key = models.CharField(max_length=180)
    title = models.CharField(max_length=180)
    body = models.CharField(max_length=500)
    url = models.CharField(max_length=500, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)
    emailed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [models.UniqueConstraint(fields=["workspace", "recipient", "event_key"], name="unique_workspace_notification_event")]
        indexes = [
            # The bell's "newest 100" (and ?page=) read straight from the index, without sorting a user's history.
            models.Index(F("workspace"), F("recipient"), F("created_at").desc(), F("id").desc(),
                         name="notification_inbox_newest"),
            # Unread count and mark-all-read touch only the unread entries.
            models.Index(fields=["workspace", "recipient"], condition=Q(read_at__isnull=True),
                         name="notification_unread"),
            # Retention (read after 90 days, unread after 180) scans by age, in bounded batches.
            models.Index(fields=["created_at"], name="notification_created"),
        ]

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        if not self._state.adding:
            return
        members = Membership.objects.filter(workspace_id=self.workspace_id)
        if not members.filter(user_id=self.recipient_id).exists():
            raise ValidationError({"recipient": "Recipient is not a workspace member."})
        if self.actor_id and not members.filter(user_id=self.actor_id).exists():
            raise ValidationError({"actor": "Actor is not a workspace member."})



class WorkspaceReportState(models.TextChoices):
    PENDING = "pending", "Pending"
    READY = "ready", "Ready"
    FAILED = "failed", "Failed"



class WorkspaceReportReportType(models.TextChoices):
    SUMMARY = "workspace_summary", "Workspace summary"
    BURNDOWN = "sprint_burndown", "Sprint burndown"
    VELOCITY = "velocity", "Velocity"


class WorkspaceReport(TenantModel):
    State = WorkspaceReportState

    ReportType = WorkspaceReportReportType

    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="flowboard_reports")
    report_type = models.CharField(max_length=30, choices=ReportType.choices, default=ReportType.SUMMARY)
    title = models.CharField(max_length=200, blank=True)
    project = models.ForeignKey("projects.Project", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    sprint = models.ForeignKey("projects.Sprint", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    state = models.CharField(max_length=10, choices=State.choices, default=State.PENDING)
    data = models.JSONField(default=dict)
    error = models.CharField(max_length=500, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            # At most one pending build per identical request; NULL project/sprint count as equal. A pending
            # report whose source was deleted (SET NULL) leaves the rule: its build can only fail, and two such
            # reports turning into the same (type, NULL, NULL) used to block deleting the project or sprint.
            models.UniqueConstraint(
                fields=["workspace", "report_type", "project", "sprint"],
                condition=Q(state="pending") & (
                    Q(report_type="workspace_summary")
                    | Q(report_type="velocity", project__isnull=False)
                    | Q(report_type="sprint_burndown", sprint__isnull=False)
                ),
                nulls_distinct=False, name="one_pending_identical_report",
            ),
            choices_check("state", WorkspaceReportState.choices, "ck_report_state"),
            # Failed reports explain why; pending and ready ones carry no error.
            models.CheckConstraint(condition=(Q(state="failed") & ~Q(error="")) | (~Q(state="failed") & Q(error="")),
                                   name="ck_report_error_iff_failed"),
            choices_check("report_type", WorkspaceReportReportType.choices, "ck_report_type"),
        ]

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        if self._state.adding and self.requested_by_id and not Membership.objects.filter(workspace_id=self.workspace_id, user_id=self.requested_by_id).exists():
            raise ValidationError({"requested_by": "Requester is not a workspace member."})
