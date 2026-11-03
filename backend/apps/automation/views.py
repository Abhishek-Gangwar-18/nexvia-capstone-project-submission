import csv
import secrets
import uuid

from django.http import HttpResponse
from django.utils import timezone
from django.utils.text import slugify
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import exceptions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.api import WorkspaceScopedMixin
from apps.issues.activity import field_changes, record_event
from apps.issues.models import AuditLog
from apps.tenants.models import Membership

from .queue import enqueue
from .reports import csv_rows, csv_safe
from .models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport
from .serializers import (
    NotificationSerializer, ReportRequestSerializer, WebhookDeliverySerializer, WebhookEndpointSerializer,
    WorkspaceReportSerializer,
)
from .tasks import deliver_webhook, generate_workspace_report

Role = Membership.Role


class WebhookEndpointViewSet(WorkspaceScopedMixin, viewsets.ModelViewSet):
    serializer_class = WebhookEndpointSerializer
    required_roles = {"create": Role.ADMIN, "update": Role.ADMIN, "partial_update": Role.ADMIN,
                      "destroy": Role.ADMIN, "test": Role.ADMIN, "deliveries": Role.ADMIN,
                      "list": Role.ADMIN, "retrieve": Role.ADMIN, "rotate_secret": Role.ADMIN}

    def get_queryset(self):
        return WebhookEndpoint.objects.for_workspace(self.workspace).select_related("created_by")

    def _audit(self, action, endpoint, changes=None):
        record_event(self.workspace, self.request.user, action, AuditLog.Entity.WEBHOOK, endpoint.name, changes=changes)

    def perform_create(self, serializer):
        self._audit(AuditLog.Action.CREATED, serializer.save(workspace=self.workspace, created_by=self.request.user))

    def perform_update(self, serializer):
        tracked = ("name", "url", "events", "is_active")
        before = {field: getattr(serializer.instance, field) for field in tracked}
        endpoint = serializer.save()
        changes = field_changes(endpoint, before, tracked)
        if changes:
            self._audit(AuditLog.Action.UPDATED, endpoint, changes)

    def perform_destroy(self, instance):
        self._audit(AuditLog.Action.DELETED, instance)
        instance.delete()

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
        error = enqueue(deliver_webhook, delivery.pk)
        if error:
            delivery.state, delivery.last_error = WebhookDelivery.State.FAILED, error
            delivery.save(update_fields=["state", "last_error", "updated_at"])
        return Response(WebhookDeliverySerializer(delivery).data, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=["post"], url_path="rotate-secret")
    def rotate_secret(self, request, pk=None):
        endpoint = self.get_object()
        endpoint.secret = secrets.token_hex(32)
        endpoint.save(update_fields=["secret", "updated_at"])
        self._audit(AuditLog.Action.SECRET_ROTATED, endpoint)
        return Response({"secret": endpoint.secret})


class NotificationViewSet(WorkspaceScopedMixin, viewsets.GenericViewSet):
    serializer_class = NotificationSerializer
    lookup_value_regex = r"\d+"
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
    """Reports are shared across the workspace: anyone who can see the data can see the report."""

    serializer_class = WorkspaceReportSerializer
    lookup_value_regex = r"\d+"
    required_roles = {"create": Role.MEMBER}

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return WorkspaceReport.objects.none()
        return WorkspaceReport.objects.for_workspace(self.workspace).select_related("requested_by")

    def list(self, request):
        return Response(WorkspaceReportSerializer(self.get_queryset()[:50], many=True).data)

    def retrieve(self, request, pk=None):
        return Response(WorkspaceReportSerializer(self.get_object()).data)

    @extend_schema(request=ReportRequestSerializer, responses=WorkspaceReportSerializer)
    def create(self, request):
        payload = ReportRequestSerializer(data=request.data, context={"request": request})
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        report_type, project, sprint = data["report_type"], data.get("project"), data.get("sprint")
        if report_type == WorkspaceReport.ReportType.BURNDOWN:
            project, title = sprint.project, f"Burndown: {sprint.name}"
        elif report_type == WorkspaceReport.ReportType.VELOCITY:
            sprint, title = None, f"Velocity: {project.name}"
        else:
            project, sprint, title = None, None, f"Workspace summary: {self.workspace.name}"
        report = WorkspaceReport.objects.create(
            workspace=self.workspace, requested_by=request.user, report_type=report_type,
            title=title[:200], project=project, sprint=sprint,
        )
        error = enqueue(generate_workspace_report, report.pk)
        if error:
            report.state, report.error = WorkspaceReport.State.FAILED, error
            report.save(update_fields=["state", "error", "updated_at"])
        return Response(WorkspaceReportSerializer(report).data, status=status.HTTP_202_ACCEPTED)

    @extend_schema(responses={(200, "text/csv"): str})
    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        report = self.get_object()
        if report.state != WorkspaceReport.State.READY:
            raise exceptions.ValidationError("This report isn't ready yet.")
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        filename = f"{slugify(report.title) or 'report'}-{report.created_at:%Y-%m-%d}.csv"
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        writer = csv.writer(response)
        for row in csv_rows(report):
            writer.writerow([csv_safe(value) for value in row])
        return response
