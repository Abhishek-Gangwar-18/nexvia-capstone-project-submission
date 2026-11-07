from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import exceptions, generics, serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenBackendError, TokenError
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.state import token_backend
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from .serializers import (
    ChangePasswordSerializer,
    LoginSerializer,
    LogoutSerializer,
    MeSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    RegisterSerializer,
    blacklist_all_tokens,
    tokens_for,
)

TokenPair = inline_serializer("TokenPair", {"refresh": serializers.CharField(), "access": serializers.CharField()})


class SafeTokenRefreshSerializer(TokenRefreshSerializer):
    """SimpleJWT looks the user up without catching DoesNotExist, so a token for a deleted user was a 500."""

    def validate(self, attrs):
        try:
            return super().validate(attrs)
        except get_user_model().DoesNotExist:
            raise exceptions.AuthenticationFailed("This account no longer exists. Log in again.", code="user_not_found")


class SafeTokenRefreshView(TokenRefreshView):
    serializer_class = SafeTokenRefreshSerializer
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_refresh"


class LoginView(TokenObtainPairView):
    serializer_class = LoginSerializer
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_login"


class RegisterView(generics.CreateAPIView):
    serializer_class = RegisterSerializer
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_register"

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            user = serializer.save()
        except IntegrityError:
            # Two concurrent sign-ups can both pass the existence check; the unique constraint decides.
            if get_user_model().objects.filter(email__iexact=serializer.validated_data["email"]).exists():
                raise exceptions.ValidationError({"email": ["An account with this email already exists."]})
            raise
        workspace = getattr(user, "landing_workspace", None)
        return Response(
            {
                "user": MeSerializer(user).data,
                **tokens_for(user),
                "workspace": workspace.slug if workspace else None,
            },
            status=status.HTTP_201_CREATED,
        )


def _is_blacklisted(raw):
    """True when the token is genuine (signature and expiry valid) but was already revoked."""
    try:
        payload = token_backend.decode(raw, verify=True)
    except TokenBackendError:
        return False
    return BlacklistedToken.objects.filter(token__jti=payload.get("jti")).exists()


class LogoutView(APIView):
    # Possession of the refresh token is the credential; the access token may already have expired.
    permission_classes = [AllowAny]

    @extend_schema(request=LogoutSerializer, responses={204: None})
    def post(self, request):
        serializer = LogoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        raw = serializer.validated_data["refresh"]
        try:
            token = RefreshToken(raw)
        except TokenError:
            if _is_blacklisted(raw):
                return Response(status=status.HTTP_204_NO_CONTENT)  # already logged out: idempotent
            raise exceptions.ValidationError({"refresh": ["Invalid or expired refresh token."]})
        token.blacklist()
        return Response(status=status.HTTP_204_NO_CONTENT)


class LogoutAllView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={204: None})
    def post(self, request):
        blacklist_all_tokens(request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(generics.RetrieveUpdateAPIView):
    serializer_class = MeSerializer
    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "patch"]

    def get_object(self):
        return self.request.user


class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_change_password"

    @extend_schema(request=ChangePasswordSerializer, responses={200: TokenPair})
    def post(self, request):
        serializer = ChangePasswordSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        user = request.user
        with transaction.atomic():
            user.set_password(serializer.validated_data["new_password"])
            user.save(update_fields=["password"])
            blacklist_all_tokens(user)  # every other session must log in again
            tokens = tokens_for(user)
        return Response(tokens, status=status.HTTP_200_OK)


class PasswordResetRequestView(APIView):
    """Always 204, whether or not the email has an account, so it can't be used to probe emails."""

    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_password_reset"

    @extend_schema(request=PasswordResetRequestSerializer, responses={204: None})
    def post(self, request):
        from apps.automation.queue import enqueue
        from apps.automation.tasks import send_password_reset_email

        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = get_user_model().objects.filter(
            email__iexact=serializer.validated_data["email"], is_active=True
        ).first()
        if user is not None and user.has_usable_password():
            enqueue(send_password_reset_email, user.pk)
        return Response(status=status.HTTP_204_NO_CONTENT)


class PasswordResetConfirmView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_password_reset_confirm"

    @extend_schema(request=PasswordResetConfirmSerializer, responses={204: None})
    def post(self, request):
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data["user"]
        with transaction.atomic():
            user.set_password(serializer.validated_data["new_password"])
            user.save(update_fields=["password"])
            blacklist_all_tokens(user)  # whoever had the old password is logged out everywhere
        return Response(status=status.HTTP_204_NO_CONTENT)
