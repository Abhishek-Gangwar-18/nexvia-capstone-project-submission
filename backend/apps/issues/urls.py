from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views
from .dashboard import DashboardView

router = DefaultRouter(trailing_slash=True)
router.register("issues", views.IssueViewSet, basename="issue")
router.register("labels", views.LabelViewSet, basename="label")
router.register("attachments", views.IssueAttachmentViewSet, basename="attachment")

urlpatterns = [
    path("dashboard/", DashboardView.as_view(), name="dashboard"),
    *router.urls,
]
