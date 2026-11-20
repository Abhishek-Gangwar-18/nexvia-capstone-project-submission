"""Layered rate limits on POST /api/auth/refresh/ (apps/accounts/throttles.py).

Offices share one public IP, so genuine refreshes are limited per verified account; invalid tokens keep the strict
per-IP limit; a generous per-IP ceiling caps everything. Counters live in the shared Redis cache.
"""
import time

import pytest
import redis
from django.conf import settings as django_settings
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts.cookie_auth import COOKIE_NAME

pytestmark = pytest.mark.django_db
COOKIE = {"HTTP_X_AUTH_MODE": "cookie"}


@pytest.fixture(autouse=True)
def small_limits(settings):
    rates = {**settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],
             "auth_refresh": "3/min", "auth_refresh_invalid": "3/min", "auth_refresh_ip": "10/min"}
    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "DEFAULT_THROTTLE_RATES": rates}


def refresh_body(token, client=None, **extra):
    return (client or APIClient()).post("/api/auth/refresh/", {"refresh": token}, format="json", **extra)


def chain(user, n):
    """Refresh n times in body mode, following the rotation like a client does. Returns the status codes."""
    token, codes = str(RefreshToken.for_user(user)), []
    for _ in range(n):
        res = refresh_body(token)
        codes.append(res.status_code)
        if res.status_code == 200:
            token = res.json()["refresh"]
    return codes


def test_users_sharing_an_ip_refresh_independently(make_user):
    # Same client IP for everyone (APIClient's 127.0.0.1). Under the old per-IP limit of 3 the 4th refresh failed.
    alice, bob, carol = make_user("alice@rl.test"), make_user("bob@rl.test"), make_user("carol@rl.test")
    assert chain(alice, 3) == [200] * 3
    assert chain(bob, 3) == [200] * 3
    assert chain(carol, 3) == [200] * 3


def test_one_account_over_its_limit_is_throttled_without_affecting_others(make_user):
    alice, bob = make_user("alice@rl.test"), make_user("bob@rl.test")
    assert chain(alice, 4) == [200, 200, 200, 429]
    assert chain(bob, 1) == [200]


def test_throttled_response_has_retry_after_and_keeps_the_cookie(make_user):
    user = make_user("tabs@rl.test")
    client = APIClient()
    client.cookies[COOKIE_NAME] = str(RefreshToken.for_user(user))
    for _ in range(3):
        assert client.post("/api/auth/refresh/", **COOKIE).status_code == 200
    res = client.post("/api/auth/refresh/", **COOKIE)
    assert res.status_code == 429
    assert int(res["Retry-After"]) > 0
    assert COOKIE_NAME not in res.cookies  # rate limited is not logged out: the cookie is neither cleared nor rotated
    assert client.cookies[COOKIE_NAME].value  # the browser still holds a working session cookie


def test_invalid_tokens_keep_the_strict_ip_limit(make_user):
    codes = [refresh_body(f"not-a-token-{i}").status_code for i in range(4)]
    assert codes == [401, 401, 401, 429]
    assert APIClient().post("/api/auth/refresh/", **COOKIE).status_code == 429  # missing cookie counts as invalid
    # Valid accounts on the same IP are still served (their own bucket, under the IP ceiling).
    assert chain(make_user("ok@rl.test"), 1) == [200]


def test_forged_or_revoked_tokens_never_spend_the_victims_budget(make_user):
    victim = make_user("victim@rl.test")
    genuine = RefreshToken.for_user(victim)
    forged = str(genuine)[:-4] + ("AAAA" if not str(genuine).endswith("AAAA") else "BBBB")  # same claims, bad signature
    revoked = RefreshToken.for_user(victim)
    revoked.blacklist()
    for _ in range(2):
        assert refresh_body(forged).status_code == 401
    assert refresh_body(str(revoked)).status_code == 401
    # Those three went to the IP's invalid-token bucket; the victim's own budget is untouched.
    assert chain(victim, 3) == [200] * 3


def test_ip_ceiling_caps_all_refreshes_from_one_address(settings, make_user):
    rates = {**settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], "auth_refresh_ip": "5/min"}
    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "DEFAULT_THROTTLE_RATES": rates}
    codes = chain(make_user("a@rl.test"), 3) + chain(make_user("b@rl.test"), 3)
    assert codes == [200] * 5 + [429]


def test_retry_works_once_the_window_resets(make_user, monkeypatch):
    user = make_user("later@rl.test")
    token = str(RefreshToken.for_user(user))
    for _ in range(3):
        token = refresh_body(token).json()["refresh"]
    assert refresh_body(token).status_code == 429
    later = time.time() + 61
    monkeypatch.setattr("rest_framework.throttling.SimpleRateThrottle.timer", lambda self: later)
    assert refresh_body(token).status_code == 200  # the same, still-valid token works after the wait


def test_counters_are_in_the_shared_redis_cache(make_user):
    """Every gunicorn worker talks to the same Redis, so a limit holds across workers (not N times the limit)."""
    assert django_settings.CACHES["default"]["BACKEND"] == "django.core.cache.backends.redis.RedisCache"
    user = make_user("shared@rl.test")
    chain(user, 1)
    # A separate connection (as another worker process would have) sees the same counters.
    other_worker = redis.Redis.from_url(django_settings.CACHES["default"]["LOCATION"])
    keys = {k.decode() for k in other_worker.keys("*throttle_auth_refresh*")}
    assert any(k.endswith(f"throttle_auth_refresh_user:{user.pk}") for k in keys)
    assert any("throttle_auth_refresh_ip_" in k for k in keys)


def test_body_mode_clients_unchanged(make_user):
    user = make_user("script@rl.test")
    res = refresh_body(str(RefreshToken.for_user(user)))
    assert res.status_code == 200
    assert set(res.json()) == {"access", "refresh"}  # rotation in the body, as before
    assert refresh_body("garbage").status_code == 401


def test_spoofed_forwarded_for_cannot_escape_the_ip_limit(settings):
    """Behind nginx only the last X-Forwarded-For entry (added by nginx) is the client. Rotating the rest of the
    header used to give every request a fresh per-IP bucket."""
    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "NUM_PROXIES": 1}
    codes = [refresh_body("bad", HTTP_X_FORWARDED_FOR=f"10.9.9.{i}, 198.51.100.7").status_code for i in range(4)]
    assert codes == [401, 401, 401, 429]
    # A different real client (last entry) has its own bucket.
    assert refresh_body("bad", HTTP_X_FORWARDED_FOR="10.9.9.1, 198.51.100.8").status_code == 401


def test_login_limit_cannot_be_escaped_with_a_spoofed_header(settings):
    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "NUM_PROXIES": 1}
    codes = [APIClient().post("/api/auth/login/", {"email": f"n{i}@rl.test", "password": "wrong-pass"}, format="json",
                              HTTP_X_FORWARDED_FOR=f"203.0.113.{i}, 198.51.100.9").status_code for i in range(6)]
    assert codes[-1] == 429  # login stays 5/min per real client IP


def test_behind_proxy_setting_trusts_one_proxy_hop():
    # docker-compose sets DJANGO_BEHIND_PROXY=True for both stacks; the settings derive NUM_PROXIES from it.
    import importlib
    import os

    import config.settings as s
    old = os.environ.get("DJANGO_BEHIND_PROXY")
    try:
        os.environ["DJANGO_BEHIND_PROXY"] = "True"
        assert importlib.reload(s).REST_FRAMEWORK["NUM_PROXIES"] == 1
        os.environ["DJANGO_BEHIND_PROXY"] = "False"
        assert importlib.reload(s).REST_FRAMEWORK["NUM_PROXIES"] is None
    finally:
        if old is None:
            os.environ.pop("DJANGO_BEHIND_PROXY", None)
        else:
            os.environ["DJANGO_BEHIND_PROXY"] = old
        importlib.reload(s)
