"""Plan limits. They only block adding more: a workspace over its limit after a downgrade keeps its data."""
from django.utils import timezone
from rest_framework import exceptions, status

from apps.projects.models import Project
from apps.tenants.models import Invitation, Membership

from .plans import plan_limits


class PlanLimitReached(exceptions.APIException):
    status_code = status.HTTP_402_PAYMENT_REQUIRED
    default_code = "plan_limit_reached"

    def __init__(self, limit, message, workspace):
        super().__init__({
            "detail": message, "code": "plan_limit_reached", "limit": limit, "current_plan": workspace.plan,
        })


def usage(workspace):
    members = Membership.objects.filter(workspace=workspace).count()
    invites = Invitation.objects.filter(
        workspace=workspace, accepted_at__isnull=True, expires_at__gt=timezone.now()
    ).count()
    return {
        "projects": Project.objects.for_workspace(workspace).filter(is_archived=False).count(),
        "members": members,
        "pending_invitations": invites,
    }


def check_can_add_project(workspace):
    limit = plan_limits(workspace.plan)["projects"]
    if limit is not None and usage(workspace)["projects"] >= limit:
        raise PlanLimitReached(
            "projects", f"Your plan allows {limit} active projects. Upgrade or archive a project to add another.", workspace
        )


def check_can_add_member(workspace):
    limit = plan_limits(workspace.plan)["members"]
    current = usage(workspace)
    if limit is not None and current["members"] + current["pending_invitations"] >= limit:
        raise PlanLimitReached(
            "members", f"Your plan allows {limit} members, counting pending invitations. Upgrade to invite more.", workspace
        )


def check_file_size(workspace, size):
    limit_mb = plan_limits(workspace.plan)["file_mb"]
    if size > limit_mb * 1024 * 1024:
        raise PlanLimitReached("file_size", f"Your plan allows files up to {limit_mb} MB. Upgrade to upload larger files.", workspace)
