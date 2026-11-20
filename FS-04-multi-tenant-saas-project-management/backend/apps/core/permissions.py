from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.tenants.models import Membership

Role = Membership.Role


def required_role(request, view):
    """Views may declare `required_roles = {"<action or method>": Role.X}`.
    Fallback: reads need VIEWER, writes need MEMBER."""
    roles = getattr(view, "required_roles", {})
    action = getattr(view, "action", None) or request.method.lower()
    method = request.method.lower()
    if method in roles:
        return roles[method]
    if action in roles:
        return roles[action]
    return Role.VIEWER if request.method in SAFE_METHODS else Role.MEMBER


class HasWorkspaceRole(BasePermission):
    message = "Your role in this workspace does not allow this action."

    def has_permission(self, request, view):
        membership = getattr(request, "membership", None)
        if membership is None:
            return False
        return membership.has_role(required_role(request, view))
