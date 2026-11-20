"""Refresh-token transport: browser (httpOnly cookie) or body (scripts, curl, tests).

The SPA opts into **cookie mode** by sending `X-Auth-Mode: cookie`. The mode is explicit per request and the two
never mix:

* cookie mode: login / register / change-password / refresh put the refresh token ONLY in the `fb_refresh`
  cookie and leave it out of the JSON body. Refresh and logout read it ONLY from that cookie: a refresh token in
  the body is ignored, and a missing cookie is a 401, never a fallback to the body.
* body mode (no header): exactly the original API. The cookie is never read or set.

The cookie is HttpOnly, SameSite=Strict, Secure wherever the session cookie is (production), and scoped to
`/api/auth/`, so the browser sends it nowhere else and no other endpoint can authenticate with it (every API
call still needs the in-memory access token). CSRF: SameSite=Strict keeps it off cross-site requests, and the
required custom header forces a CORS preflight that production (no allowed origins) never grants. The header is
not a CSRF token: this relies on CORS staying closed to untrusted origins (and never allowing credentials).
"""
from django.conf import settings

COOKIE_NAME = "fb_refresh"
COOKIE_PATH = "/api/auth/"
MODE_HEADER = "HTTP_X_AUTH_MODE"


def is_cookie_mode(request):
    return request.META.get(MODE_HEADER, "").strip().lower() == "cookie"


def cookie_token(request):
    return request.COOKIES.get(COOKIE_NAME) or None


EXPIRED = "Thu, 01 Jan 1970 00:00:00 GMT"


def _attributes():
    # Identical when setting and when clearing (Path, Domain, HttpOnly, Secure, SameSite), so the clearing
    # Set-Cookie always matches the cookie that was set. (Django's delete_cookie() can't take `secure`.)
    return {"path": COOKIE_PATH, "domain": None, "samesite": "Strict", "httponly": True,
            "secure": settings.SESSION_COOKIE_SECURE}


def set_refresh_cookie(response, refresh):
    response.set_cookie(COOKIE_NAME, str(refresh),
                        max_age=int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds()), **_attributes())


def clear_refresh_cookie(response):
    response.set_cookie(COOKIE_NAME, "", max_age=0, expires=EXPIRED, **_attributes())


def deliver(request, response):
    """Move a freshly issued refresh token from the body into the cookie, in cookie mode only."""
    if is_cookie_mode(request) and isinstance(getattr(response, "data", None), dict) and "refresh" in response.data:
        set_refresh_cookie(response, response.data.pop("refresh"))
    return response
