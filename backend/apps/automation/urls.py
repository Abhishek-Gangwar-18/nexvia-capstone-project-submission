from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import NotificationViewSet, WebhookEndpointViewSet, WorkspaceReportViewSet

router = DefaultRouter(trailing_slash=True)
router.register("webhooks", WebhookEndpointViewSet, basename="webhook")
router.register("notifications", NotificationViewSet, basename="notification")
router.register("reports", WorkspaceReportViewSet, basename="workspace-report")

urlpatterns = [path("", include(router.urls))]
