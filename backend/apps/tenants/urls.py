from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter(trailing_slash=True)
router.register("workspaces", views.WorkspaceListCreateView, basename="workspace")
router.register("members", views.MemberViewSet, basename="member")
router.register("invitations", views.InvitationViewSet, basename="invitation")

urlpatterns = [
    path("workspace/", views.CurrentWorkspaceView.as_view(), name="current-workspace"),
    path("invitations/accept/", views.InvitationAcceptView.as_view(), name="invitation-accept"),
    path("invitations/preview/<str:token>/", views.InvitationPreviewView.as_view(), name="invitation-preview"),
    *router.urls,
]
