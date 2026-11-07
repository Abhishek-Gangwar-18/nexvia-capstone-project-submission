import csv
import secrets
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, transaction
from django.http import HttpResponse
from django.utils import timezone
from django.utils.text import slugify
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import exceptions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.api import WorkspaceScopedMixin
from apps.core.pagination import AlwaysPageNumberPagination, paginate_or_cap
from apps.core.throttling import (
    ReportCreateThrottle, WebhookRedeliverThrottle, WebhookTestEndpointThrottle, WebhookTestUserThrottle,
)
from apps.issues.activity import field_changes, record_event
from apps.issues.models import AuditLog
from apps.tenants.models import Membership, Workspace

from .queue import enqueue
from .reports import csv_rows, csv_safe
from .models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport
from .serializers import (
    NotificationSerializer, ReportRequestSerializer, WebhookDeliverySerializer, WebhookEndpointSerializer,
    WorkspaceReportSerializer,
)
from .tasks import deliver_webhook, generate_workspace_report

Role = Membership.Role
STALE_REPORT_AFTER = timedelta(minutes=15)  # a pending build older than this is treated as lost


def _with_secret(data, endpoint):
    """The one response that carries the full secret. Clients must show it once and not store it."""
    return {**data, "secret": endpoint.secret}


class WebhookEndpointViewSet(WorkspaceScopedMixin, viewsets.ModelViewSet):
    """Every lookup goes through get_queryset(), which is scoped to the request's workspace: an endpoint
    or delivery id from another tenant is a 404."""

    serializer_class = WebhookEndpointSerializer
    http_method_names = ["get", "post", "patch", "delete"]  # no PUT: edits are PATCH
    required_roles = {"create": Role.ADMIN, "update": Role.ADMIN, "partial_update": Role.ADMIN,
                      "destroy": Role.ADMIN, "test": Role.ADMIN, "deliveries": Role.ADMIN,
                      "list": Role.ADMIN, "retrieve": Role.ADMIN, "rotate_secret": Role.ADMIN,
                      "redeliver": Role.ADMIN}

    def get_throttles(self):
        if self.action == "test":
            return [WebhookTestEndpointThrottle(), WebhookTestUserThrottle()]
        if self.action == "redeliver":
            return [WebhookRedeliverThrottle()]
        return super().get_throttles()

    def get_queryset(self):
        return WebhookEndpoint.objects.for_workspace(self.workspace).select_related("created_by")

    def _audit(self, action, endpoint, changes=None):
        # Never pass the secret into changes: audit rows are readable by every admin.
        record_event(self.workspace, self.request.user, action, AuditLog.Entity.WEBHOOK, endpoint.name, changes=changes)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            # Same convention as projects and invitations: lock the workspace row, then check the cap.
            Workspace.objects.select_for_update().filter(pk=self.workspace.pk).first()
            limit = settings.MAX_WEBHOOKS_PER_WORKSPACE
            if WebhookEndpoint.objects.for_workspace(self.workspace).count() >= limit:
                raise exceptions.ValidationError({"detail": f"A workspace can have at most {limit} webhooks."})
            endpoint = serializer.save(workspace=self.workspace, created_by=request.user)
            self._audit(AuditLog.Action.CREATED, endpoint)
        return Response(_with_secret(self.get_serializer(endpoint).data, endpoint), status=status.HTTP_201_CREATED)

    def perform_update(self, serializer):
        tracked = ("name", "url", "events", "is_active")
        before = {field: getattr(serializer.instance, field) for field in tracked}
        extra = {}
        if serializer.validated_data.get("is_active") and not serializer.instance.is_active:
            extra = {"consecutive_failures": 0, "disabled_at": None, "disabled_reason": ""}  # re-enabled by hand
        endpoint = serializer.save(**extra)
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
        deliveries = WebhookDelivery.objects.for_workspace(self.workspace).filter(endpoint=endpoint).order_by("-created_at", "-id")
        # Unpaged: the newest 100, as before. ?page= pages 50 at a time (max 200).
        return paginate_or_cap(self, request, deliveries, WebhookDeliverySerializer, newest_first=True, cap=100)

    def _require_active(self, endpoint):
        if not endpoint.is_active:
            raise exceptions.ValidationError({"detail": "This webhook is disabled. Enable it first."})

    @extend_schema(request=None, responses=WebhookDeliverySerializer)
    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        endpoint = self.get_object()
        self._require_active(endpoint)
        delivery = WebhookDelivery.objects.create(
            workspace=self.workspace, endpoint=endpoint, event_id=uuid.uuid4(), event="webhook.test",
            payload={"message": "FlowBoard webhook test", "workspace": self.workspace.slug},
        )
        return self._queue(delivery)

    @extend_schema(request=None, responses=WebhookDeliverySerializer,
                   parameters=[OpenApiParameter("delivery_id", int, OpenApiParameter.PATH)])
    @action(detail=True, methods=["post"], url_path=r"deliveries/(?P<delivery_id>\d+)/redeliver")
    def redeliver(self, request, pk=None, delivery_id=None):
        endpoint = self.get_object()
        original = WebhookDelivery.objects.for_workspace(self.workspace).filter(endpoint=endpoint, pk=delivery_id).first()
        if original is None:
            raise exceptions.NotFound("Delivery not found.")
        if original.state != WebhookDelivery.State.FAILED:
            raise exceptions.ValidationError({"detail": "Only failed deliveries can be redelivered."})
        self._require_active(endpoint)  # redelivery can't bypass a disabled endpoint or the SSRF checks
        delivery = WebhookDelivery.objects.create(
            workspace=self.workspace, endpoint=endpoint, event_id=original.event_id, event=original.event,
            payload=original.payload, redelivery_of=original,
        )
        return self._queue(delivery)

    def _queue(self, delivery):
        error = enqueue(deliver_webhook, delivery.pk)
        if error:
            delivery.state, delivery.last_error = WebhookDelivery.State.FAILED, error
            delivery.save(update_fields=["state", "last_error", "updated_at"])
        delivery.refresh_from_db()
        return Response(WebhookDeliverySerializer(delivery).data, status=status.HTTP_202_ACCEPTED)

    @extend_schema(request=None, responses=inline_serializer("WebhookSecret", {"secret": serializers.CharField()}))
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
        return (Notification.objects.for_workspace(self.workspace).filter(recipient=self.request.user)
                .select_related("actor").order_by("-created_at", "-id"))

    def list(self, request):
        # unread_count always covers every unread notification, not just the page being returned.
        unread = self.get_queryset().filter(read_at__isnull=True).count()
        if "page" in request.query_params:
            paginator = AlwaysPageNumberPagination()
            page = paginator.paginate_queryset(self.get_queryset(), request, view=self)
            response = paginator.get_paginated_response(NotificationSerializer(page, many=True).data)
            response.data["unread_count"] = unread
            return response
        return Response({"unread_count": unread,
                         "results": NotificationSerializer(self.get_queryset()[:100], many=True).data})

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

    def get_throttles(self):
        return [ReportCreateThrottle()] if self.action == "create" else super().get_throttles()

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return WorkspaceReport.objects.none()
        return (WorkspaceReport.objects.for_workspace(self.workspace).select_related("requested_by")
                .order_by("-created_at", "-id"))

    def list(self, request):
        return paginate_or_cap(self, request, self.get_queryset(), WorkspaceReportSerializer, newest_first=True, cap=50)

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
        identity = {"report_type": report_type, "project": project, "sprint": sprint}
        try:
            with transaction.atomic():
                # Serialize identical requests on the workspace row; the partial unique constraint is the backstop.
                Workspace.objects.select_for_update().filter(pk=self.workspace.pk).first()
                pending = WorkspaceReport.objects.for_workspace(self.workspace).filter(
                    state=WorkspaceReport.State.PENDING, **identity
                ).first()
                if pending and timezone.now() - pending.created_at < STALE_REPORT_AFTER:
                    return Response(WorkspaceReportSerializer(pending).data, status=status.HTTP_200_OK)
                if pending:  # its worker was lost; don't let it block new requests forever
                    pending.state, pending.error = WorkspaceReport.State.FAILED, "Report generation failed. Try again."
                    pending.save(update_fields=["state", "error", "updated_at"])
                report = WorkspaceReport.objects.create(
                    workspace=self.workspace, requested_by=request.user, title=title[:200], **identity
                )
        except IntegrityError:
            pending = WorkspaceReport.objects.for_workspace(self.workspace).get(state=WorkspaceReport.State.PENDING, **identity)
            return Response(WorkspaceReportSerializer(pending).data, status=status.HTTP_200_OK)
        error = enqueue(generate_workspace_report, report.pk)
        if error:
            report.state, report.error = WorkspaceReport.State.FAILED, error
            report.save(update_fields=["state", "error", "updated_at"])
        report.refresh_from_db()
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
