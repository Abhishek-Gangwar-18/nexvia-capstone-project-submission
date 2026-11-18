from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Count, IntegerField, OuterRef, Subquery, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import exceptions, mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.generics import RetrieveUpdateDestroyAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.automation.queue import enqueue
from apps.billing.limits import check_can_add_member
from apps.automation.tasks import send_invitation_email
from apps.core.api import WorkspaceScopedMixin
from apps.issues.activity import record_event
from apps.issues.models import AuditLog
from apps.projects.models import Project

from .models import (
    Invitation, Membership, Workspace, default_invite_expiry, generate_invite_token, hash_invite_token,
)
from .serializers import (
    AcceptInvitationSerializer,
    DeleteWorkspaceSerializer,
    InvitationPreviewSerializer,
    InvitationSerializer,
    MemberSerializer,
    TransferOwnershipSerializer,
    WorkspaceSerializer,
)
from .deletion import start_deletion
from .services import (
    accept_invitation,
    assert_can_change_role,
    assert_can_remove,
    create_workspace,
    remove_member,
    transfer_ownership,
)

Role = Membership.Role


def find_invitation(token):
    """Look an invitation up by its raw token. Only the hash is stored, so hash first; the hash is unique,
    so .get(). Missing and malformed tokens both come back as None (the caller's invalid/expired answer)."""
    if not isinstance(token, str) or "\x00" in token:
        return None
    if not token:
        return None
    try:
        return Invitation.objects.select_related("workspace", "invited_by").get(
            token_hash=hash_invite_token(token), workspace__deleting_at__isnull=True)
    except Invitation.DoesNotExist:
        return None


def annotated_workspaces(user):
    # order_by(): one unique row per (workspace, user), so no ordering (and no JOINs for it) is needed.
    role = Membership.objects.filter(workspace=OuterRef("pk"), user=user).order_by().values("role")[:1]
    projects = (
        Project.objects.filter(workspace=OuterRef("pk"), is_archived=False)
        .order_by().values("workspace").annotate(c=Count("id")).values("c")
    )
    return (
        Workspace.objects.filter(memberships__user=user, deleting_at__isnull=True)
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
    throttle_scope = "workspace_create"

    def get_throttles(self):
        return [ScopedRateThrottle()] if self.action == "create" else []

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Workspace.objects.none()
        return annotated_workspaces(self.request.user)

    def perform_create(self, serializer):
        workspace = create_workspace(
            name=serializer.validated_data["name"], owner=self.request.user, enforce_owner_limit=True
        )
        serializer.instance = annotated_workspaces(self.request.user).get(pk=workspace.pk)


class CurrentWorkspaceView(WorkspaceScopedMixin, RetrieveUpdateDestroyAPIView):
    serializer_class = WorkspaceSerializer
    required_roles = {"patch": Role.ADMIN, "put": Role.ADMIN, "delete": Role.OWNER}
    http_method_names = ["get", "patch", "delete"]

    def get_object(self):
        return annotated_workspaces(self.request.user).get(pk=self.workspace.pk)

    def perform_update(self, serializer):
        old_name = serializer.instance.name
        workspace = serializer.save()
        if workspace.name != old_name:
            record_event(workspace, self.request.user, AuditLog.Action.UPDATED, AuditLog.Entity.WORKSPACE, workspace.name,
                         changes={"name": {"from": old_name, "to": workspace.name}})

    @extend_schema(request=DeleteWorkspaceSerializer, responses={202: None})
    def delete(self, request, *args, **kwargs):
        # Irreversible: the caller must type the slug and re-enter their password.
        DeleteWorkspaceSerializer(data=request.data, context={"request": request}).is_valid(raise_exception=True)
        # Only mark it here. Stripe is cancelled by the durable background purge, AFTER this mark has committed:
        # cancelling in the request first could leave a live workspace with no subscription if the process
        # died between the two. The purge retries Stripe and touches no data until the cancellation succeeds.
        start_deletion(self.workspace)  # hidden from now on; data removed in the background
        return Response({"detail": "Workspace deletion started."}, status=status.HTTP_202_ACCEPTED)


class TransferOwnershipView(WorkspaceScopedMixin, APIView):
    required_roles = {"post": Role.OWNER}

    @extend_schema(request=TransferOwnershipSerializer, responses=WorkspaceSerializer)
    def post(self, request):
        serializer = TransferOwnershipSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        transfer_ownership(self.workspace, request.user, serializer.validated_data["member_id"])
        return Response(WorkspaceSerializer(annotated_workspaces(request.user).get(pk=self.workspace.pk)).data)


class MemberViewSet(WorkspaceScopedMixin, mixins.ListModelMixin, mixins.UpdateModelMixin,
                    mixins.DestroyModelMixin, viewsets.GenericViewSet):
    serializer_class = MemberSerializer
    http_method_names = ["get", "patch", "delete"]
    # Anyone may call destroy (to leave); the services decide who may change or remove whom.
    required_roles = {"partial_update": Role.ADMIN, "destroy": Role.VIEWER}
    search_fields = ["user__email", "user__first_name", "user__last_name"]

    def get_queryset(self):
        return Membership.objects.filter(workspace=self.workspace).select_related("user", "workspace").order_by(
            "user__first_name", "user__last_name"
        )

    def perform_update(self, serializer):
        target = serializer.instance
        new_role = serializer.validated_data.get("role", target.role)
        assert_can_change_role(self.membership, target, new_role)
        old_role = target.role
        member = serializer.save()
        if member.role != old_role:
            record_event(self.workspace, self.request.user, AuditLog.Action.ROLE_CHANGED, AuditLog.Entity.MEMBER,
                         member.user.email, changes={"role": {"from": old_role, "to": member.role}})

    def perform_destroy(self, instance):
        assert_can_remove(self.membership, instance)
        remove_member(instance, self.request.user)


class InvitationViewSet(WorkspaceScopedMixin, mixins.ListModelMixin, mixins.CreateModelMixin,
                        mixins.DestroyModelMixin, viewsets.GenericViewSet):
    serializer_class = InvitationSerializer
    required_roles = {"list": Role.ADMIN, "create": Role.ADMIN, "destroy": Role.ADMIN, "resend": Role.ADMIN}
    lookup_value_regex = r"\d+"

    def get_queryset(self):
        open_invites = Invitation.objects.filter(
            workspace=self.workspace, accepted_at__isnull=True
        ).select_related("invited_by", "workspace")
        if self.action == "list":
            # Expired rows are filtered in SQL; the daily purge task deletes them later.
            return open_invites.filter(expires_at__gt=timezone.now())
        return open_invites  # revoke/resend still find expired ones, so they get a clear answer

    def perform_create(self, serializer):
        email = serializer.validated_data["email"]
        try:
            with transaction.atomic():
                # Lock the workspace: concurrent invites queue here, so the plan limit and duplicate checks hold.
                Workspace.objects.select_for_update(no_key=True).filter(pk=self.workspace.pk).first()
                Invitation.objects.filter(
                    workspace=self.workspace, email=email, accepted_at__isnull=True,
                    expires_at__lte=timezone.now(),
                ).delete()
                check_can_add_member(self.workspace)
                raw_token = generate_invite_token()
                invitation = serializer.save(
                    workspace=self.workspace, invited_by=self.request.user, token_hash=hash_invite_token(raw_token)
                )
                invitation._raw_token = raw_token  # this response's accept_url; never stored
        except IntegrityError:  # the unique_open_invitation constraint is the last line of defence
            raise exceptions.ValidationError({"email": ["An invitation is already pending for this email."]})
        record_event(self.workspace, self.request.user, AuditLog.Action.INVITED, AuditLog.Entity.INVITATION,
                     invitation.email, changes={"role": invitation.role})
        # The raw token rides in the task message (the worker can't rebuild it from the hash).
        transaction.on_commit(lambda: enqueue(send_invitation_email, invitation.pk, raw_token))

    def perform_destroy(self, instance):
        record_event(self.workspace, self.request.user, AuditLog.Action.REVOKED, AuditLog.Entity.INVITATION, instance.email)
        instance.delete()

    @extend_schema(request=None, responses=inline_serializer(
        "InvitationResend", {"queued": serializers.BooleanField(), "accept_url": serializers.URLField()}))
    @action(detail=True, methods=["post"])
    def resend(self, request, pk=None):
        cooldown = timedelta(seconds=settings.INVITATION_RESEND_COOLDOWN)
        pk = self.get_object().pk  # 404 for foreign or accepted invitations
        with transaction.atomic():
            # Row lock: two concurrent resends can't both pass the cooldown check.
            invitation = Invitation.objects.select_for_update().get(pk=pk)
            now = timezone.now()
            if invitation.expires_at <= now:
                raise exceptions.ValidationError("This invitation has expired. Revoke it and invite again.")
            if invitation.email_sent_at and now - invitation.email_sent_at < cooldown:
                wait = (cooldown - (now - invitation.email_sent_at)).total_seconds()
                raise exceptions.Throttled(wait=wait, detail="This invitation was just sent. Try again in a minute.")
            invitation.email_sent_at = now
            invitation.expires_at = default_invite_expiry()
            # A resend issues a fresh link (the old one stops working): the stored hash can't be turned back into
            # the previous link, and this is the moment the admin can copy it.
            raw_token = invitation.issue_token()
            invitation.save(update_fields=["email_sent_at", "expires_at", "token_hash", "updated_at"])
        # Committed: only now hand the email to the queue.
        queued = enqueue(send_invitation_email, invitation.pk, raw_token) is None
        return Response({"queued": queued, "accept_url": invitation.accept_url}, status=status.HTTP_202_ACCEPTED)


class InvitationPreviewView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "invitation_public"

    @extend_schema(responses=InvitationPreviewSerializer)
    def get(self, request, token):
        invitation = find_invitation(token)
        if invitation is None:
            raise exceptions.NotFound("Invitation not found.")
        return Response(InvitationPreviewSerializer(invitation).data)


class InvitationAcceptView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "invitation_public"

    @extend_schema(request=AcceptInvitationSerializer, responses=WorkspaceSerializer)
    def post(self, request):
        serializer = AcceptInvitationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        invitation = find_invitation(serializer.validated_data["token"])
        # is_usable re-checks that an admin invitation's sender still owns the workspace.
        if invitation is None or not invitation.is_usable:
            raise exceptions.ValidationError({"token": ["This invitation is invalid or has expired."]})
        if invitation.email.lower() != request.user.email.lower():
            raise exceptions.PermissionDenied("This invitation was sent to a different email address.")
        workspace = accept_invitation(invitation, request.user)
        data = WorkspaceSerializer(annotated_workspaces(request.user).get(pk=workspace.pk)).data
        return Response(data, status=status.HTTP_200_OK)
