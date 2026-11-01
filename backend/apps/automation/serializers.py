from rest_framework import serializers

from apps.accounts.serializers import UserMiniSerializer
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
        from django.conf import settings
        from urllib.parse import urlparse
        parsed = urlparse(value)
        if parsed.scheme != "https" and not (settings.DEBUG and parsed.scheme == "http"):
            raise serializers.ValidationError("Use an HTTPS URL (HTTP is allowed in local DEBUG mode).")
        if not parsed.hostname or parsed.username or parsed.password:
            raise serializers.ValidationError("URL must include a hostname and cannot contain credentials.")
        return value


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

    class Meta:
        model = WorkspaceReport
        fields = ["id", "report_type", "state", "data", "error", "created_at", "updated_at"]
        read_only_fields = fields
