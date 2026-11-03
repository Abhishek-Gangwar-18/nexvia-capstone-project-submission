import ipaddress
from urllib.parse import urlparse

from django.conf import settings
from rest_framework import serializers

from apps.accounts.serializers import UserMiniSerializer
from apps.core.fields import TenantPrimaryKeyRelatedField
from apps.projects.models import Project, Sprint
from .models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport

EVENT_CHOICES = [(f"issue.{event}", f"Issue {event}") for event in
                 ("created", "updated", "moved", "commented", "attached", "detached", "deleted")]


class WebhookEndpointSerializer(serializers.ModelSerializer):
    created_by = UserMiniSerializer(read_only=True)

    class Meta:
        model = WebhookEndpoint
        fields = ["id", "name", "url", "secret", "events", "is_active", "created_by", "created_at", "updated_at"]
        read_only_fields = ["id", "secret", "created_by", "created_at", "updated_at"]

    def validate_events(self, values):
        if not isinstance(values, list) or len(values) > 8 or any(not isinstance(event, str) for event in values):
            raise serializers.ValidationError("Select a unique list of up to 8 event names.")
        if len(set(values)) != len(values):
            raise serializers.ValidationError("Select a unique list of up to 8 event names.")
        allowed = {event for event, _ in EVENT_CHOICES} | {"*"}
        if any(event not in allowed for event in values):
            raise serializers.ValidationError("One or more event names are not supported.")
        return values

    def validate_url(self, value):
        parsed = urlparse(value)
        if parsed.scheme != "https" and not (settings.DEBUG and parsed.scheme == "http"):
            raise serializers.ValidationError("Use an HTTPS URL (HTTP is allowed in local DEBUG mode).")
        if not parsed.hostname or parsed.username or parsed.password:
            raise serializers.ValidationError("URL must include a hostname and cannot contain credentials.")
        if not settings.DEBUG and self._is_internal(parsed.hostname):
            raise serializers.ValidationError("Webhook URLs can't point at internal addresses.")
        return value


    @staticmethod
    def _is_internal(hostname):
        if hostname.lower() == "localhost" or hostname.lower().endswith(".localhost"):
            return True
        try:
            return not ipaddress.ip_address(hostname).is_global
        except ValueError:
            return False  # a DNS name: checked again at delivery time, when it is resolved


class WebhookDeliverySerializer(serializers.ModelSerializer):
    state = serializers.CharField(read_only=True)

    class Meta:
        model = WebhookDelivery
        fields = ["id", "event_id", "event", "state", "attempts", "response_status", "response_body",
                  "last_error", "next_attempt_at", "delivered_at", "created_at"]


class NotificationSerializer(serializers.ModelSerializer):
    actor = UserMiniSerializer(read_only=True)

    class Meta:
        model = Notification
        fields = ["id", "actor", "event_key", "title", "body", "url", "read_at", "created_at"]
        read_only_fields = fields


class WorkspaceReportSerializer(serializers.ModelSerializer):
    state = serializers.CharField(read_only=True)
    requested_by = UserMiniSerializer(read_only=True)

    class Meta:
        model = WorkspaceReport
        fields = ["id", "report_type", "title", "project", "sprint", "requested_by", "state", "data", "error",
                  "created_at", "updated_at"]
        read_only_fields = fields


class ReportRequestSerializer(serializers.Serializer):
    report_type = serializers.ChoiceField(choices=WorkspaceReport.ReportType.choices, default=WorkspaceReport.ReportType.SUMMARY)
    project = TenantPrimaryKeyRelatedField(queryset=Project.objects.all(), required=False, allow_null=True)
    sprint = TenantPrimaryKeyRelatedField(queryset=Sprint.objects.all(), required=False, allow_null=True)

    def validate(self, attrs):
        report_type = attrs["report_type"]
        if report_type == WorkspaceReport.ReportType.VELOCITY and not attrs.get("project"):
            raise serializers.ValidationError({"project": "Choose a project for the velocity report."})
        if report_type == WorkspaceReport.ReportType.BURNDOWN:
            sprint = attrs.get("sprint")
            if not sprint:
                raise serializers.ValidationError({"sprint": "Choose a sprint for the burndown report."})
            if sprint.state == Sprint.State.PLANNED or not sprint.start_date:
                raise serializers.ValidationError({"sprint": "This sprint hasn't started yet."})
        return attrs
