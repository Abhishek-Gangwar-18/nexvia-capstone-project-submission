from django.contrib.auth.password_validation import validate_password
from django.db import transaction
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.tokens import RefreshToken

from apps.tenants.models import Invitation
from apps.tenants.services import accept_invitation, create_workspace

from .models import AVATAR_COLORS, User


class UserMiniSerializer(serializers.ModelSerializer):
    display_name = serializers.CharField(read_only=True)
    initials = serializers.CharField(read_only=True)

    class Meta:
        model = User
        fields = ["id", "email", "display_name", "initials", "avatar_color", "job_title"]
        read_only_fields = fields


class MeSerializer(serializers.ModelSerializer):
    display_name = serializers.CharField(read_only=True)
    initials = serializers.CharField(read_only=True)

    class Meta:
        model = User
        fields = [
            "id", "email", "first_name", "last_name", "display_name", "initials",
            "avatar_color", "job_title", "email_notifications", "is_staff", "date_joined",
        ]
        read_only_fields = ["id", "email", "is_staff", "date_joined"]

    def validate_avatar_color(self, value):
        if value not in AVATAR_COLORS:
            raise serializers.ValidationError("Pick one of the palette colours.")
        return value


def tokens_for(user):
    refresh = RefreshToken.for_user(user)
    return {"refresh": str(refresh), "access": str(refresh.access_token)}


class LoginSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        attrs[self.username_field] = attrs[self.username_field].strip().lower()
        data = super().validate(attrs)
        data["user"] = MeSerializer(self.user).data
        return data


class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, style={"input_type": "password"})
    first_name = serializers.CharField(max_length=150)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    workspace_name = serializers.CharField(max_length=100, required=False, allow_blank=True)
    invite_token = serializers.CharField(required=False, allow_blank=True)

    def validate_email(self, value):
        value = value.strip().lower()
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("An account with this email already exists.")
        return value

    def validate(self, attrs):
        validate_password(attrs["password"], user=User(email=attrs["email"], first_name=attrs["first_name"]))
        token = attrs.get("invite_token")
        if token:
            invitation = Invitation.objects.select_related("workspace").filter(token=token).first()
            if invitation is None or not invitation.is_pending:
                raise serializers.ValidationError({"invite_token": "This invitation is invalid or has expired."})
            if invitation.email.lower() != attrs["email"]:
                raise serializers.ValidationError({"email": "Use the email address the invitation was sent to."})
            attrs["invitation"] = invitation
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        user = User.objects.create_user(
            email=validated_data["email"],
            password=validated_data["password"],
            first_name=validated_data["first_name"],
            last_name=validated_data.get("last_name", ""),
        )
        workspace = None
        if validated_data.get("invitation"):
            workspace = accept_invitation(validated_data["invitation"], user)
        if validated_data.get("workspace_name"):
            workspace = create_workspace(name=validated_data["workspace_name"], owner=user)
        user.landing_workspace = workspace
        return user


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True)

    def validate_current_password(self, value):
        if not self.context["request"].user.check_password(value):
            raise serializers.ValidationError("Current password is incorrect.")
        return value

    def validate_new_password(self, value):
        validate_password(value, user=self.context["request"].user)
        return value
