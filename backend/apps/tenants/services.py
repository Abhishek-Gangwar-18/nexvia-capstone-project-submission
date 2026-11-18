from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import exceptions

from .models import Membership, Workspace

Role = Membership.Role
SLUG_RETRIES = 5


def _audit(*args, **kwargs):
    from apps.issues.activity import record_event  # issues depends on tenants at import time

    record_event(*args, **kwargs)


@transaction.atomic
def create_workspace(*, name, owner, plan=Workspace.Plan.FREE, slug="", enforce_owner_limit=False):
    if enforce_owner_limit:
        # Lock the owner's row so two concurrent creates can't both slip under the cap.
        get_user_model().objects.select_for_update().filter(pk=owner.pk).first()
        limit = settings.MAX_OWNED_WORKSPACES
        if Workspace.objects.filter(owner=owner, deleting_at__isnull=True).count() >= limit:
            raise exceptions.ValidationError({"name": [f"You can own at most {limit} workspaces."]})
    workspace = _insert_workspace(name=name, owner=owner, plan=plan, slug=slug)
    Membership.objects.create(workspace=workspace, user=owner, role=Role.OWNER)
    _audit(workspace, owner, "created", "workspace", workspace.name)
    return workspace


def _insert_workspace(*, name, owner, plan, slug):
    """The DB unique constraint is the authority on slugs: on a collision, pick the next free suffix and retry."""
    for attempt in range(SLUG_RETRIES):
        workspace = Workspace(name=name, owner=owner, plan=plan, slug=slug)
        try:
            with transaction.atomic():
                workspace.save()
            return workspace
        except IntegrityError:
            if slug or attempt == SLUG_RETRIES - 1:
                raise  # an explicit slug is the caller's choice; don't silently change it
    raise AssertionError("unreachable")


def is_member(workspace, user):
    return Membership.objects.filter(workspace=workspace, user=user).exists()


@transaction.atomic
def accept_invitation(invitation, user):
    """Join the invited workspace (idempotent if already a member) and close the invitation."""
    _, joined = Membership.objects.get_or_create(
        workspace=invitation.workspace, user=user, defaults={"role": invitation.role}
    )
    if joined:
        # Everything reporting needs about the invite lives here, because accepted invitations are purged
        # after INVITATION_RETENTION_DAYS: who joined (actor + label), where, when (this row), and who invited.
        inviter = invitation.invited_by
        _audit(invitation.workspace, user, "joined", "member", user.email, changes={
            "role": invitation.role,
            "invited_by": {"id": inviter.pk, "email": inviter.email} if inviter else None,
            "invited_at": invitation.created_at.isoformat(),
        })
    invitation.accepted_at = timezone.now()
    invitation.save(update_fields=["accepted_at", "updated_at"])
    return invitation.workspace


# ---------------------------------------------------------------------------------- member management
#
#   Action                              Owner   Admin
#   grant / change / remove an admin     yes     no
#   manage members and viewers           yes     yes
#   change the owner role                no: use transfer_ownership
#   change your own role                 no      no

def assert_can_change_role(actor, target, new_role):
    if new_role == Role.OWNER:
        raise exceptions.ValidationError({"role": ["Ownership changes go through the transfer-ownership endpoint."]})
    if target.role == Role.OWNER:
        raise exceptions.PermissionDenied("The owner's role can't be changed. Use transfer ownership.")
    if target.user_id == actor.user_id:
        raise exceptions.PermissionDenied("You can't change your own role.")
    if not actor.has_role(Role.ADMIN):
        raise exceptions.PermissionDenied("Only admins can change roles.")
    if Role.ADMIN in (target.role, new_role) and actor.role != Role.OWNER:
        raise exceptions.PermissionDenied("Only the owner can grant or change the admin role.")


def assert_can_invite_as(actor, role):
    if role == Role.OWNER:
        raise exceptions.ValidationError({"role": ["You can't invite someone as owner."]})
    if role == Role.ADMIN and actor.role != Role.OWNER:
        raise exceptions.ValidationError({"role": ["Only the owner can invite admins."]})


def assert_can_remove(actor, target):
    if target.role == Role.OWNER:
        raise exceptions.PermissionDenied("The workspace owner can't be removed. Transfer ownership first.")
    if target.user_id == actor.user_id:
        return  # anyone but the owner may leave
    if not actor.has_role(Role.ADMIN):
        raise exceptions.PermissionDenied("Only admins can remove members.")
    if target.role == Role.ADMIN and actor.role != Role.OWNER:
        raise exceptions.PermissionDenied("Only the owner can remove an admin.")


@transaction.atomic
def remove_member(membership, actor):
    """Delete the membership and unassign the user's issues in this workspace, in one transaction.
    Closed issues are unassigned too: Issue validation requires every assignee to be a current member,
    so a stale assignee would block later edits. Reporter, comments and audit history are kept, and the
    user account is untouched. (The post_delete signal in issues/signals.py repeats this for other paths.)"""
    from apps.issues.models import AuditLog, Issue

    workspace, user = membership.workspace, membership.user
    unassigned = Issue.objects.filter(workspace=workspace, assignee=user).update(
        assignee=None, updated_at=timezone.now()
    )
    leaving = user.pk == actor.pk
    _audit(workspace, actor, AuditLog.Action.LEFT if leaving else AuditLog.Action.REMOVED, AuditLog.Entity.MEMBER,
           user.email, changes={"role": membership.role, "unassigned_issues": unassigned})
    membership.delete()
    return unassigned


@transaction.atomic
def transfer_ownership(workspace, actor, target_membership_id):
    """Only to someone who has already joined. Membership is re-read on every request, so there is no
    permission cache to invalidate: both users' new roles apply from their next call."""
    from apps.issues.models import AuditLog

    workspace = Workspace.objects.select_for_update(no_key=True).get(pk=workspace.pk)
    if workspace.owner_id != actor.pk:
        raise exceptions.PermissionDenied("Only the owner can transfer ownership.")
    # of=("self",): lock the membership rows only. Without it, FOR UPDATE also locks every joined
    # accounts_user row, blocking unrelated profile saves and logins (last_login) during a transfer.
    locked = Membership.objects.select_for_update(of=("self",)).select_related("user").filter(workspace=workspace)
    current = locked.filter(user=actor).first()
    target = locked.filter(pk=target_membership_id).first()
    if target is None:
        raise exceptions.ValidationError({"member_id": ["Pick a current member of this workspace."]})
    if target.user_id == actor.pk:
        raise exceptions.ValidationError({"member_id": ["You already own this workspace."]})
    # Demote first, so there is never a moment with two owners.
    current.role = Role.ADMIN
    current.save(update_fields=["role", "updated_at"])
    previous_role = target.role
    target.role = Role.OWNER
    target.save(update_fields=["role", "updated_at"])
    workspace.owner = target.user
    workspace.save(update_fields=["owner", "updated_at"])
    _audit(workspace, actor, AuditLog.Action.OWNERSHIP_TRANSFERRED, AuditLog.Entity.WORKSPACE, workspace.name,
           changes={"owner": {"from": actor.email, "to": target.user.email}, "new_owner_previous_role": previous_role})
    # Invoices and payment emails should reach the new owner. Queued only once the transfer has committed.
    from apps.automation.queue import enqueue
    from apps.billing.models import Subscription
    from apps.billing.tasks import update_billing_email

    if Subscription.objects.filter(workspace=workspace).exists():
        workspace_id = workspace.pk
        transaction.on_commit(lambda: enqueue(update_billing_email, workspace_id))
    return workspace
