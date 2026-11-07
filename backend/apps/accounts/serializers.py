from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode
from django.db import transaction
from django.core.cache import cache
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import exceptions, serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.tenants.models import Invitation
from apps.tenants.services import accept_invitation, create_workspace

from .models import AVATAR_COLORS, User


def normalize_email(value):
    """Single normalization used by register and login (and by UserManager: lowercased)."""
    return value.strip().lower()


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
            "avatar_color", "job_title", "email_notifications", "date_joined",
        ]
        read_only_fields = ["id", "email", "date_joined"]

    def validate_avatar_color(self, value):
        if value not in AVATAR_COLORS:
            raise serializers.ValidationError("Pick one of the palette colours.")
        return value


def tokens_for(user):
    refresh = RefreshToken.for_user(user)
    return {"refresh": str(refresh), "access": str(refresh.access_token)}


def blacklist_all_tokens(user):
    """Revoke every refresh token issued to the user (logout everywhere)."""
    outstanding = OutstandingToken.objects.filter(user=user, blacklistedtoken__isnull=True)
    BlacklistedToken.objects.bulk_create(
        [BlacklistedToken(token=token) for token in outstanding], ignore_conflicts=True
    )


def _check_password(password, user, field):
    """Run Django's validators and report failures under the given field, not non_field_errors."""
    try:
        validate_password(password, user=user)
    except DjangoValidationError as exc:
        raise serializers.ValidationError({field: list(exc.messages)})


def _required_text(value, label):
    value = value.strip()
    if not value:
        raise serializers.ValidationError(f"{label} cannot be blank.")
    return value


LOGIN_FAILURE_LIMIT = 10
LOGIN_FAILURE_WINDOW = 15 * 60  # seconds


def _login_failure_key(email):
    return f"login-failures:{email}"


class LoginSerializer(TokenObtainPairSerializer):
    """Besides the per-IP throttle, lock an email out after repeated failures from any number of IPs."""

    def validate(self, attrs):
        email = attrs[self.username_field] = normalize_email(attrs[self.username_field])
        key = _login_failure_key(email)
        if cache.get(key, 0) >= LOGIN_FAILURE_LIMIT:
            raise exceptions.Throttled(
                wait=LOGIN_FAILURE_WINDOW,
                detail="Too many failed login attempts for this account. Try again in 15 minutes.",
            )
        try:
            data = super().validate(attrs)
        except exceptions.AuthenticationFailed:
            cache.add(key, 0, LOGIN_FAILURE_WINDOW)  # window starts at the first failure
            try:
                cache.incr(key)
            except ValueError:  # expired between add and incr
                cache.set(key, 1, LOGIN_FAILURE_WINDOW)
            raise
        cache.delete(key)
        data["user"] = MeSerializer(self.user).data
        return data


class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, style={"input_type": "password"})
    first_name = serializers.CharField(max_length=150)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    # Optional (invited users join an existing workspace), but if sent it must not be blank.
    workspace_name = serializers.CharField(max_length=100, required=False, trim_whitespace=False)
    invite_token = serializers.CharField(required=False, allow_blank=True)

    def validate_first_name(self, value):
        return _required_text(value, "First name")

    def validate_last_name(self, value):
        return value.strip()

    def validate_workspace_name(self, value):
        return _required_text(value, "Workspace name")

    def validate_email(self, value):
        value = normalize_email(value)
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("An account with this email already exists.")
        return value

    def validate(self, attrs):
        _check_password(attrs["password"], User(email=attrs["email"], first_name=attrs["first_name"]), "password")
        token = attrs.get("invite_token")
        if token:
            invitation = Invitation.objects.select_related("workspace").filter(token=token).first()
            if invitation is None or not invitation.is_usable:
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


class LogoutSerializer(serializers.Serializer):
    refresh = serializers.CharField()


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


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()

    def validate_email(self, value):
        return normalize_email(value)


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField()
    token = serializers.CharField()
    new_password = serializers.CharField(write_only=True)

    default_error = "This reset link is invalid or has expired. Request a new one."

    def validate(self, attrs):
        try:
            pk = force_str(urlsafe_base64_decode(attrs["uid"]))
            user = User.objects.get(pk=pk, is_active=True)
        except (TypeError, ValueError, OverflowError, User.DoesNotExist):
            raise serializers.ValidationError({"token": [self.default_error]})
        # Single use: the token hashes the password, so it dies once the password changes.
        if not default_token_generator.check_token(user, attrs["token"]):
            raise serializers.ValidationError({"token": [self.default_error]})
        _check_password(attrs["new_password"], user, "new_password")
        attrs["user"] = user
        return attrs
