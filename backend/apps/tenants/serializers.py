from django.utils import timezone
from rest_framework import serializers

from apps.accounts.serializers import UserMiniSerializer, normalize_email

from .models import Invitation, Membership, Workspace
from .services import assert_can_invite_as

Role = Membership.Role


class StrictCharField(serializers.CharField):
    """Like CharField, but a number, list or object is a 400 instead of being coerced to a string."""

    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid")
        return super().to_internal_value(data)


class WorkspaceSerializer(serializers.ModelSerializer):
    owner = UserMiniSerializer(read_only=True)
    role = serializers.CharField(source="my_role", read_only=True, default=None)
    member_count = serializers.IntegerField(read_only=True, default=0)
    project_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Workspace
        fields = ["id", "name", "slug", "plan", "owner", "role", "member_count", "project_count", "created_at"]
        read_only_fields = ["slug", "plan", "created_at"]

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Workspace name cannot be blank.")
        return value


class DeleteWorkspaceSerializer(serializers.Serializer):
    confirm = StrictCharField(help_text="The workspace slug, typed out to confirm.")
    password = StrictCharField(write_only=True, trim_whitespace=False, help_text="Your current password.")

    def validate(self, attrs):
        request = self.context["request"]
        if attrs["confirm"] != request.workspace.slug:
            raise serializers.ValidationError({"confirm": ["Type the workspace slug exactly to confirm."]})
        if not request.user.check_password(attrs["password"]):
            raise serializers.ValidationError({"password": ["Password is incorrect."]})
        return attrs


class TransferOwnershipSerializer(serializers.Serializer):
    member_id = serializers.IntegerField(min_value=1, help_text="Membership id of the new owner.")


class MemberSerializer(serializers.ModelSerializer):
    user = UserMiniSerializer(read_only=True)
    joined_at = serializers.DateTimeField(source="created_at", read_only=True)

    class Meta:
        model = Membership
        fields = ["id", "user", "role", "joined_at"]


class InvitationSerializer(serializers.ModelSerializer):
    invited_by = UserMiniSerializer(read_only=True)
    # Present only in the create response (and resend's): the stored hash can't be turned back into a link.
    accept_url = serializers.CharField(read_only=True, allow_null=True)

    class Meta:
        model = Invitation
        fields = ["id", "email", "role", "invited_by", "expires_at", "accept_url", "email_sent_at", "created_at"]
        read_only_fields = ["expires_at", "email_sent_at", "created_at"]

    def validate_email(self, value):
        value = normalize_email(value)
        workspace = self.context["request"].workspace
        if Membership.objects.filter(workspace=workspace, user__email=value).exists():
            raise serializers.ValidationError("This person is already a member.")
        if Invitation.objects.filter(
            workspace=workspace, email=value, accepted_at__isnull=True, expires_at__gt=timezone.now()
        ).exists():
            raise serializers.ValidationError("An invitation is already pending for this email.")
        return value

    def validate_role(self, role):
        assert_can_invite_as(self.context["request"].membership, role)
        return role


class AcceptInvitationSerializer(serializers.Serializer):
    token = StrictCharField(max_length=64)


class InvitationPreviewSerializer(serializers.ModelSerializer):
    workspace = serializers.CharField(source="workspace.name")
    workspace_slug = serializers.CharField(source="workspace.slug")
    invited_by = serializers.CharField(source="invited_by.display_name", default=None)
    is_pending = serializers.BooleanField(source="is_usable")
    user_exists = serializers.SerializerMethodField()

    class Meta:
        model = Invitation
        fields = ["email", "role", "workspace", "workspace_slug", "invited_by", "is_pending", "user_exists", "expires_at"]

    def get_user_exists(self, obj) -> bool:
        from apps.accounts.models import User

        return User.objects.filter(email=normalize_email(obj.email)).exists()
