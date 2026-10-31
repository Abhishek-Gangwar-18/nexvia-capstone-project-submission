from django.contrib.auth import get_user_model
from rest_framework import serializers


class TenantPrimaryKeyRelatedField(serializers.PrimaryKeyRelatedField):
    """PK field whose choices are limited to the request's workspace: a foreign id is 'does not exist'."""

    def get_queryset(self):
        request = self.context.get("request")
        return super().get_queryset().for_workspace(getattr(request, "workspace", None))


class WorkspaceMemberField(serializers.PrimaryKeyRelatedField):
    """User PK field limited to members of the request's workspace."""

    def get_queryset(self):
        request = self.context.get("request")
        workspace = getattr(request, "workspace", None)
        users = get_user_model().objects
        return users.filter(memberships__workspace=workspace) if workspace else users.none()
