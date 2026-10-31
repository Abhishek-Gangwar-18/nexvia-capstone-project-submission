from django.db.models import Count, IntegerField, OuterRef, Subquery, Value
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import exceptions, mixins, serializers, status, viewsets
from rest_framework.generics import RetrieveUpdateDestroyAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.api import WorkspaceScopedMixin
from apps.projects.models import Project

from .models import Invitation, Membership, Workspace
from .serializers import InvitationPreviewSerializer, InvitationSerializer, MemberSerializer, WorkspaceSerializer
from .services import accept_invitation, create_workspace

Role = Membership.Role


def annotated_workspaces(user):
    role = Membership.objects.filter(workspace=OuterRef("pk"), user=user).values("role")[:1]
    projects = (
        Project.objects.filter(workspace=OuterRef("pk"), is_archived=False)
        .order_by().values("workspace").annotate(c=Count("id")).values("c")
    )
    return (
        Workspace.objects.filter(memberships__user=user)
        .select_related("owner")
        .annotate(
            my_role=Subquery(role),
            member_count=Subquery(
                Membership.objects.filter(workspace=OuterRef("pk"))
                .order_by().values("workspace").annotate(c=Count("id")).values("c")
            ),
            project_count=Coalesce(Subquery(projects, output_field=IntegerField()), Value(0)),
        )
    )


class WorkspaceListCreateView(mixins.ListModelMixin, mixins.CreateModelMixin, viewsets.GenericViewSet):
    """Workspaces the caller belongs to. Not tenant-scoped: this is how the client picks a tenant."""

    serializer_class = WorkspaceSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Workspace.objects.none()
        return annotated_workspaces(self.request.user)

    def perform_create(self, serializer):
        workspace = create_workspace(name=serializer.validated_data["name"], owner=self.request.user)
        serializer.instance = annotated_workspaces(self.request.user).get(pk=workspace.pk)


class CurrentWorkspaceView(WorkspaceScopedMixin, RetrieveUpdateDestroyAPIView):
    serializer_class = WorkspaceSerializer
    required_roles = {"patch": Role.ADMIN, "put": Role.ADMIN, "delete": Role.OWNER}
    http_method_names = ["get", "patch", "delete"]

    def get_object(self):
        return annotated_workspaces(self.request.user).get(pk=self.workspace.pk)


class MemberViewSet(WorkspaceScopedMixin, mixins.ListModelMixin, mixins.UpdateModelMixin,
                    mixins.DestroyModelMixin, viewsets.GenericViewSet):
    serializer_class = MemberSerializer
    http_method_names = ["get", "patch", "delete"]
    # Anyone may call destroy (to leave); perform_destroy decides who can remove whom.
    required_roles = {"partial_update": Role.ADMIN, "destroy": Role.VIEWER}
    search_fields = ["user__email", "user__first_name", "user__last_name"]

    def get_queryset(self):
        return Membership.objects.filter(workspace=self.workspace).select_related("user").order_by(
            "user__first_name", "user__last_name"
        )

    def perform_update(self, serializer):
        target = serializer.instance
        if target.role == Role.OWNER:
            raise exceptions.PermissionDenied("The owner's role can't be changed.")
        if target.user_id == self.request.user.id:
            raise exceptions.PermissionDenied("You can't change your own role.")
        serializer.save()

    def perform_destroy(self, instance):
        if instance.role == Role.OWNER:
            raise exceptions.PermissionDenied("The workspace owner can't be removed.")
        leaving = instance.user_id == self.request.user.id
        if not leaving and not self.membership.has_role(Role.ADMIN):
            raise exceptions.PermissionDenied("Only admins can remove members.")
        instance.delete()


class InvitationViewSet(WorkspaceScopedMixin, mixins.ListModelMixin, mixins.CreateModelMixin,
                        mixins.DestroyModelMixin, viewsets.GenericViewSet):
    serializer_class = InvitationSerializer
    required_roles = {"list": Role.ADMIN, "create": Role.ADMIN, "destroy": Role.ADMIN}

    def get_queryset(self):
        return Invitation.objects.filter(workspace=self.workspace, accepted_at__isnull=True).select_related(
            "invited_by"
        )

    def list(self, request, *args, **kwargs):
        pending = [inv for inv in self.get_queryset() if inv.is_pending]
        return Response(self.get_serializer(pending, many=True).data)

    def perform_create(self, serializer):
        serializer.save(workspace=self.workspace, invited_by=self.request.user)


class InvitationPreviewView(APIView):
    permission_classes = [AllowAny]

    @extend_schema(responses=InvitationPreviewSerializer)
    def get(self, request, token):
        invitation = Invitation.objects.select_related("workspace", "invited_by").filter(token=token).first()
        if invitation is None:
            raise exceptions.NotFound("Invitation not found.")
        return Response(InvitationPreviewSerializer(invitation).data)


class InvitationAcceptView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=inline_serializer("AcceptInvitation", {"token": serializers.CharField()}),
        responses=WorkspaceSerializer,
    )
    def post(self, request):
        invitation = Invitation.objects.select_related("workspace").filter(token=request.data.get("token", "")).first()
        if invitation is None or not invitation.is_pending:
            raise exceptions.ValidationError({"token": "This invitation is invalid or has expired."})
        if invitation.email.lower() != request.user.email.lower():
            raise exceptions.PermissionDenied("This invitation was sent to a different email address.")
        workspace = accept_invitation(invitation, request.user)
        data = WorkspaceSerializer(annotated_workspaces(request.user).get(pk=workspace.pk)).data
        return Response(data, status=status.HTTP_200_OK)
