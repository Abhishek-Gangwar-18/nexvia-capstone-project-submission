from rest_framework import serializers

from apps.accounts.serializers import UserMiniSerializer

from .models import Invitation, Membership, Workspace

Role = Membership.Role


class WorkspaceSerializer(serializers.ModelSerializer):
    owner = UserMiniSerializer(read_only=True)
    role = serializers.CharField(source="my_role", read_only=True, default=None)
    member_count = serializers.IntegerField(read_only=True, default=0)
    project_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Workspace
        fields = ["id", "name", "slug", "plan", "owner", "role", "member_count", "project_count", "created_at"]
        read_only_fields = ["slug", "plan", "created_at"]


class MemberSerializer(serializers.ModelSerializer):
    user = UserMiniSerializer(read_only=True)
    joined_at = serializers.DateTimeField(source="created_at", read_only=True)

    class Meta:
        model = Membership
        fields = ["id", "user", "role", "joined_at"]

    def validate_role(self, role):
        if role == Role.OWNER:
            raise serializers.ValidationError("Ownership can't be assigned here.")
        return role


class InvitationSerializer(serializers.ModelSerializer):
    invited_by = UserMiniSerializer(read_only=True)
    accept_url = serializers.CharField(read_only=True)

    class Meta:
        model = Invitation
        fields = ["id", "email", "role", "invited_by", "expires_at", "accept_url", "created_at"]
        read_only_fields = ["expires_at", "created_at"]

    def validate_email(self, value):
        value = value.strip().lower()
        workspace = self.context["request"].workspace
        if Membership.objects.filter(workspace=workspace, user__email__iexact=value).exists():
            raise serializers.ValidationError("This person is already a member.")
        pending = Invitation.objects.filter(workspace=workspace, email__iexact=value, accepted_at__isnull=True)
        if any(inv.is_pending for inv in pending):
            raise serializers.ValidationError("An invitation is already pending for this email.")
        return value

    def validate_role(self, role):
        if role == Role.OWNER:
            raise serializers.ValidationError("You can't invite someone as owner.")
        return role


class InvitationPreviewSerializer(serializers.ModelSerializer):
    workspace = serializers.CharField(source="workspace.name")
    workspace_slug = serializers.CharField(source="workspace.slug")
    invited_by = serializers.CharField(source="invited_by.display_name", default=None)
    is_pending = serializers.BooleanField()
    user_exists = serializers.SerializerMethodField()

    class Meta:
        model = Invitation
        fields = ["email", "role", "workspace", "workspace_slug", "invited_by", "is_pending", "user_exists", "expires_at"]

    def get_user_exists(self, obj) -> bool:
        from apps.accounts.models import User

        return User.objects.filter(email__iexact=obj.email).exists()
