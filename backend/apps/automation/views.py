import uuid
import secrets

from django.utils import timezone
from drf_spectacular.utils import extend_schema
from drf_spectacular.utils import OpenApiParameter
from rest_framework import exceptions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.api import WorkspaceScopedMixin
from apps.tenants.models import Membership

from .models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport
from .serializers import NotificationSerializer, WebhookDeliverySerializer, WebhookEndpointSerializer, WorkspaceReportSerializer
from .tasks import deliver_webhook, generate_workspace_report

Role = Membership.Role


class WebhookEndpointViewSet(WorkspaceScopedMixin, viewsets.ModelViewSet):
    serializer_class = WebhookEndpointSerializer
    required_roles = {"create": Role.ADMIN, "update": Role.ADMIN, "partial_update": Role.ADMIN,
                      "destroy": Role.ADMIN, "test": Role.ADMIN, "deliveries": Role.ADMIN,
                      "list": Role.ADMIN, "retrieve": Role.ADMIN, "rotate_secret": Role.ADMIN}

    def get_queryset(self):
        return WebhookEndpoint.objects.for_workspace(self.workspace).select_related("created_by")

    def perform_create(self, serializer):
        serializer.save(workspace=self.workspace, created_by=self.request.user)

    @extend_schema(responses=WebhookDeliverySerializer(many=True))
    @action(detail=True, methods=["get"])
    def deliveries(self, request, pk=None):
        endpoint = self.get_object()
        deliveries = WebhookDelivery.objects.for_workspace(self.workspace).filter(endpoint=endpoint)
        return Response(WebhookDeliverySerializer(deliveries[:100], many=True).data)

    @extend_schema(responses=WebhookDeliverySerializer)
    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        endpoint = self.get_object()
        delivery = WebhookDelivery.objects.create(
            workspace=self.workspace, endpoint=endpoint, event_id=uuid.uuid4(), event="webhook.test",
            payload={"message": "FlowBoard webhook test", "workspace": self.workspace.slug},
        )
        deliver_webhook.delay(delivery.pk)
        return Response(WebhookDeliverySerializer(delivery).data, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=["post"], url_path="rotate-secret")
    def rotate_secret(self, request, pk=None):
        endpoint = self.get_object()
        endpoint.secret = secrets.token_hex(32)
        endpoint.save(update_fields=["secret", "updated_at"])
        return Response({"secret": endpoint.secret})


class NotificationViewSet(WorkspaceScopedMixin, viewsets.GenericViewSet):
    serializer_class = NotificationSerializer
    required_roles = {"mark_all_read": Role.VIEWER, "mark_read": Role.VIEWER}

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Notification.objects.none()
        return Notification.objects.for_workspace(self.workspace).filter(recipient=self.request.user).select_related("actor")

    def list(self, request):
        notifications = self.get_queryset()[:100]
        return Response({"unread_count": self.get_queryset().filter(read_at__isnull=True).count(),
                         "results": NotificationSerializer(notifications, many=True).data})

    @extend_schema(parameters=[OpenApiParameter("id", int, OpenApiParameter.PATH)])
    @action(detail=True, methods=["post"], url_path="read")
    def mark_read(self, request, pk=None):
        item = self.get_queryset().filter(pk=pk).first()
        if item is None:
            raise exceptions.NotFound("Notification not found.")
        if item.read_at is None:
            item.read_at = timezone.now()
            item.save(update_fields=["read_at", "updated_at"])
        return Response(NotificationSerializer(item).data)

    @action(detail=False, methods=["post"], url_path="read-all")
    def mark_all_read(self, request):
        updated = self.get_queryset().filter(read_at__isnull=True).update(read_at=timezone.now(), updated_at=timezone.now())
        return Response({"updated": updated})


class WorkspaceReportViewSet(WorkspaceScopedMixin, viewsets.GenericViewSet):
    serializer_class = WorkspaceReportSerializer
    required_roles = {"create": Role.MEMBER}

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return WorkspaceReport.objects.none()
        return WorkspaceReport.objects.for_workspace(self.workspace).filter(requested_by=self.request.user)

    def list(self, request):
        return Response(WorkspaceReportSerializer(self.get_queryset()[:50], many=True).data)

    def create(self, request):
        report = WorkspaceReport.objects.create(workspace=self.workspace, requested_by=request.user)
        generate_workspace_report.delay(report.pk)
        return Response(WorkspaceReportSerializer(report).data, status=status.HTTP_202_ACCEPTED)
