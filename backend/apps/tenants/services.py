from django.db import transaction
from django.utils import timezone

from .models import Membership, Workspace


@transaction.atomic
def create_workspace(*, name, owner, plan=Workspace.Plan.FREE, slug=""):
    workspace = Workspace.objects.create(name=name, owner=owner, plan=plan, slug=slug)
    Membership.objects.create(workspace=workspace, user=owner, role=Membership.Role.OWNER)
    return workspace


def is_member(workspace, user):
    return Membership.objects.filter(workspace=workspace, user=user).exists()


@transaction.atomic
def accept_invitation(invitation, user):
    """Join the invited workspace (idempotent if already a member) and close the invitation."""
    Membership.objects.get_or_create(
        workspace=invitation.workspace, user=user, defaults={"role": invitation.role}
    )
    invitation.accepted_at = timezone.now()
    invitation.save(update_fields=["accepted_at", "updated_at"])
    return invitation.workspace
