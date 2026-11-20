"""Per-account login lockout, shared by the API login and the Django admin login.

State lives in the shared cache (Redis, database 1: settings.CACHES), so every gunicorn worker and container
sees the same counter. One counter per normalised email, whatever the entry point: failures on the API and on
the admin add up, and a success on either clears it. The per-IP side is handled by DRF throttles (API) and by
nginx's limit_req on /admin/login/.
"""
from django.core.cache import cache

LOGIN_FAILURE_LIMIT = 10
LOGIN_FAILURE_WINDOW = 15 * 60  # seconds, counted from the first failure


def failure_key(email):
    return f"login-failures:{email}"


def is_locked(email):
    return cache.get(failure_key(email), 0) >= LOGIN_FAILURE_LIMIT


def record_failure(email):
    key = failure_key(email)
    cache.add(key, 0, LOGIN_FAILURE_WINDOW)  # the window starts at the first failure
    try:
        cache.incr(key)
    except ValueError:  # expired between add and incr
        cache.set(key, 1, LOGIN_FAILURE_WINDOW)


def clear(email):
    cache.delete(failure_key(email))
