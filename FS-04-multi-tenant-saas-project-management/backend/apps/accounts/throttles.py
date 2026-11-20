"""Layered rate limits for POST /api/auth/refresh/.

Every page load restores the browser session through a refresh, and offices put hundreds of people behind one
public IP, so a single per-IP limit throttles legitimate users. Instead (all counters in the shared Redis cache, so
they hold across gunicorn workers):

* ``auth_refresh_ip``: a generous ceiling per client IP for every refresh request (overall abuse protection);
* ``auth_refresh``: per **verified** account, for genuine refresh tokens. The account is taken from a token whose
  signature, expiry and type have been checked and that isn't blacklisted, never from an unverified claim, so a
  forged or stolen-and-revoked token can't spend someone else's budget;
* ``auth_refresh_invalid``: per IP, for everything else (missing, malformed, expired, forged or revoked tokens),
  the same strict limit the endpoint had before.

Throttled requests get 429 with Retry-After and leave the session (and the refresh cookie) untouched.
"""
from django.conf import settings
from rest_framework.throttling import SimpleRateThrottle
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.settings import api_settings as jwt_settings
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
from rest_framework_simplejwt.tokens import RefreshToken


class _SettingsRateThrottle(SimpleRateThrottle):
    def get_rate(self):
        # Read the rate when the throttle is created (not at import), like the rest of the settings.
        return settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"][self.scope]


class RefreshIPThrottle(_SettingsRateThrottle):
    scope = "auth_refresh_ip"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class RefreshInvalidThrottle(RefreshIPThrottle):
    scope = "auth_refresh_invalid"


class RefreshUserThrottle(_SettingsRateThrottle):
    scope = "auth_refresh"

    def __init__(self, user_id):
        self.user_id = user_id
        super().__init__()

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": f"user:{self.user_id}"}


def verified_refresh_user_id(raw):
    """The account id of a genuine, unrevoked refresh token, or None. Never trusts an unverified claim."""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        token = RefreshToken(raw)  # checks signature, expiry and token type
    except TokenError:
        return None
    if BlacklistedToken.objects.filter(token__jti=token.get(jwt_settings.JTI_CLAIM)).exists():
        return None
    return token.get(jwt_settings.USER_ID_CLAIM)


def throttles_for(raw):
    """The throttles a refresh request must pass, in order: the IP ceiling, then account or invalid-token limit."""
    user_id = verified_refresh_user_id(raw)
    second = RefreshUserThrottle(user_id) if user_id is not None else RefreshInvalidThrottle()
    return [RefreshIPThrottle(), second]
