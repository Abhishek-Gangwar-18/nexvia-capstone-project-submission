"""
Request-correlated, tenant-aware logging.

Every request gets a request id (taken from a trusted `X-Request-ID`, e.g. set by nginx, or generated).
The id, the tenant and the user live in a ContextVar, and `ContextFilter` copies them onto every log
record, so all lines from one request (Django, DRF, Stripe, our own code) can be grepped together:

    2026-11-05 19:20:25,312 INFO    [req=3f9c1a2b7d4e tenant=acme user=12] flowboard.request: POST /api/issues/WEB-4/move/ 200 18ms role=owner

The same context travels into Celery tasks (see config/celery.py), so a background job's lines carry the
id of the request that queued it. Interleaved lines with different ids at the same timestamp are how
concurrent requests (and race conditions) show up.
"""
import logging
import re
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar

from .context import get_current_workspace

FIELDS = ("request_id", "tenant", "user_id")
EMPTY = "-"
REQUEST_ID_HEADER = "HTTP_X_REQUEST_ID"
_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

_log_context = ContextVar("log_context", default=None)

REDACTED = "[REDACTED]"
# Links that carry a secret in the path: password reset (/reset-password/<uid>/<token>), invitation pages and
# the invite preview API. The secret is everything after the prefix, so the whole tail is masked. The pattern
# also matches inside query strings, raw or percent-encoded (e.g. /login?next=%2Finvite%2F<token>).
_SECRET_PATH = re.compile(r"(?i)(/|%2F)(reset-password|invite|api(?:/|%2F)invitations(?:/|%2F)preview)(/|%2F)[^?&#\s]*")
# Query parameters whose values are secrets, whatever the path.
_SECRET_PARAM = re.compile(r"(?i)([?&](?:token|uid|key|secret|password|code|refresh|access)=)[^&#]*")


def redact_path(full_path):
    """The request line as it may be logged: secret path segments and secret query values replaced."""
    masked = _SECRET_PATH.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}{REDACTED}", full_path)
    return _SECRET_PARAM.sub(lambda m: f"{m.group(1)}{REDACTED}", masked)
access_logger = logging.getLogger("flowboard.request")


def get_log_context():
    return _log_context.get() or {}


def bind_log_context(**fields):
    """Add fields (e.g. tenant/user once they are known) to the current request's or task's context."""
    context = dict(get_log_context())
    context.update({key: value for key, value in fields.items() if value is not None})
    _log_context.set(context)


@contextmanager
def log_context(**fields):
    token = _log_context.set({**get_log_context(), **fields})
    try:
        yield
    finally:
        _log_context.reset(token)


def new_request_id():
    return uuid.uuid4().hex[:12]


def clean_request_id(value):
    """Accept a caller-supplied id only if it is short and safe to print; otherwise make a new one."""
    return value if isinstance(value, str) and _VALID_REQUEST_ID.match(value) else new_request_id()


class ContextFilter(logging.Filter):
    """Attach request_id / tenant / user_id to every record (defaults to '-' outside a request)."""

    def filter(self, record):
        context = get_log_context()
        for field in FIELDS:
            if not hasattr(record, field):
                setattr(record, field, context.get(field, EMPTY))
        if record.tenant == EMPTY:
            workspace = get_current_workspace()  # e.g. a Celery task inside workspace_context()
            if workspace is not None:
                record.tenant = workspace.slug
        return True


class SkipClientErrorResponses(logging.Filter):
    """
    Django logs "Bad Request: /api/..." for every 4xx *after* the middleware chain, so those lines have no
    request id. The flowboard.request line already records them (at WARNING), so drop the duplicates.
    5xx lines stay: their tracebacks are logged inside the request, with full context.
    """

    def filter(self, record):
        status = getattr(record, "status_code", None)
        return not (isinstance(status, int) and 400 <= status < 500)


class RequestLogMiddleware:
    """Assigns the request id, returns it as `X-Request-ID`, and writes one access line per request."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request_id = clean_request_id(request.META.get(REQUEST_ID_HEADER))
        request.request_id = request_id
        token = _log_context.set({"request_id": request_id})
        started = time.perf_counter()
        try:
            response = self.get_response(request)
            response["X-Request-ID"] = request_id
            self._log(request, response.status_code, (time.perf_counter() - started) * 1000)
            return response
        finally:
            _log_context.reset(token)

    def _log(self, request, status, duration_ms):
        user = getattr(request, "user", None)
        user_id = str(user.pk) if user is not None and user.is_authenticated else EMPTY
        workspace = getattr(request, "workspace", None)
        membership = getattr(request, "membership", None)
        asked = getattr(request, "workspace_slug", None)
        if workspace is not None:
            tenant = workspace.slug
        elif asked:
            # The caller named a workspace that wasn't granted (not a member / doesn't exist / not authenticated).
            tenant = f"{asked}(unverified)"[:80]
        else:
            tenant = EMPTY
        bind_log_context(tenant=tenant, user_id=user_id)
        level = logging.ERROR if status >= 500 else logging.WARNING if status >= 400 else logging.INFO
        role = membership.role if membership is not None else EMPTY
        access_logger.log(
            level,
            "%s %s %s %dms role=%s",
            request.method, redact_path(request.get_full_path())[:300], status, duration_ms, role,
            extra={
                "request_id": request.request_id, "tenant": tenant, "user_id": user_id,
                "http_method": request.method, "http_status": status, "duration_ms": round(duration_ms, 1), "role": role,
            },
        )


class RedactSecretPaths(logging.Filter):
    """Last line of defence on the console handler: Django's own lines (e.g. "Internal Server Error: <path>"
    from django.request) also print request paths. Mask secrets in the message and its string arguments."""

    def filter(self, record):
        if isinstance(record.msg, str):
            record.msg = redact_path(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact_path(arg) if isinstance(arg, str) else arg for arg in record.args)
        return True
