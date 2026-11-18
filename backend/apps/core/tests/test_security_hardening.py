"""Security hardening, Phase 1 (production configuration): API docs gating, shared admin/API login lockout,
production CORS / HSTS / HTTPS-redirect defaults. The nginx side (admin allowlist, trusted proxies, rate limit,
security headers, CSP) is covered by scripts/nginx_security_test.sh against the built image."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from django.conf import settings as django_settings
from django.test import Client
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts.lockout import LOGIN_FAILURE_LIMIT, failure_key

pytestmark = pytest.mark.django_db
BACKEND = Path(__file__).resolve().parents[3]


def settings_in_subprocess(**env):
    """Import config.settings in a clean interpreter with the given environment; return a few values."""
    code = (
        "import json, os; os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings');"
        "from django.conf import settings as s;"
        "print(json.dumps({k: getattr(s, k) for k in ('API_DOCS', 'CORS_ALLOWED_ORIGINS', 'SECURE_HSTS_SECONDS',"
        " 'SECURE_HSTS_INCLUDE_SUBDOMAINS', 'SECURE_HSTS_PRELOAD', 'SECURE_SSL_REDIRECT', 'SECURE_REDIRECT_EXEMPT')}))"
    )
    clean = {k: v for k, v in os.environ.items() if not k.startswith(("DJANGO_", "API_DOCS", "CORS_"))}
    result = subprocess.run([sys.executable, "-c", code], cwd=BACKEND, env={**clean, **env},
                            capture_output=True, text=True)
    return result


def bearer(user):
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(user).access_token}")
    return client


# ============================================================ 1. Swagger / OpenAPI

class TestApiDocs:
    URLS = ("/api/schema/", "/api/docs/")

    def test_off_is_a_404_for_everyone(self, settings, make_user):
        settings.API_DOCS = "off"
        staff = make_user("staff@x.test", is_staff=True)
        for url in self.URLS:
            assert APIClient().get(url).status_code == 404
            assert bearer(staff).get(url).status_code == 404

    def test_staff_mode_requires_an_authenticated_staff_user(self, settings, make_user):
        settings.API_DOCS = "staff"
        member = make_user("member@x.test")
        staff = make_user("staff@x.test", is_staff=True)
        for url in self.URLS:
            assert APIClient().get(url).status_code in (401, 403)
            assert bearer(member).get(url).status_code == 403
            assert bearer(staff).get(url).status_code == 200
        session = Client()
        session.force_login(staff)  # an admin session works too (Swagger UI in the browser)
        assert session.get("/api/schema/").status_code == 200

    def test_public_mode_is_open(self, settings):
        settings.API_DOCS = "public"
        for url in self.URLS:
            assert APIClient().get(url).status_code == 200

    def test_defaults_follow_debug_and_invalid_values_fail(self):
        assert json.loads(settings_in_subprocess(DJANGO_DEBUG="False").stdout)["API_DOCS"] == "off"
        assert json.loads(settings_in_subprocess(DJANGO_DEBUG="True").stdout)["API_DOCS"] == "public"
        bad = settings_in_subprocess(DJANGO_DEBUG="False", API_DOCS="everyone")
        assert bad.returncode != 0 and "API_DOCS must be public, staff or off" in bad.stderr


# ======================================================= 2. admin login lockout

class TestAdminLockout:
    @pytest.fixture
    def staff(self, make_user):
        return make_user("boss@x.test", is_staff=True, is_superuser=True)

    def admin_login(self, email, password):
        client = Client()
        response = client.post("/admin/login/?next=/admin/", {"username": email, "password": password})
        return response, client

    def test_lockout_state_lives_in_the_shared_redis_cache(self):
        assert django_settings.CACHES["default"]["BACKEND"].endswith("RedisCache")

    def test_ten_failures_lock_the_account_even_with_the_right_password(self, staff):
        for _ in range(LOGIN_FAILURE_LIMIT):
            response, _ = self.admin_login("boss@x.test", "wrong")
            assert response.status_code == 200 and "Please enter the correct" in response.content.decode()
        response, client = self.admin_login("BOSS@x.test", "pass12345")  # normalised email, right password
        assert response.status_code == 200 and "Too many failed login attempts" in response.content.decode()
        assert client.get("/admin/").status_code == 302  # not logged in

    def test_admin_and_api_failures_share_one_counter(self, staff):
        from django.core.cache import cache

        half = LOGIN_FAILURE_LIMIT // 2
        for _ in range(half):
            self.admin_login("boss@x.test", "wrong")
        for _ in range(LOGIN_FAILURE_LIMIT - half):
            APIClient().post("/api/auth/login/", {"email": "boss@x.test", "password": "wrong"}, format="json")
        assert cache.get(failure_key("boss@x.test")) == LOGIN_FAILURE_LIMIT
        api = APIClient().post("/api/auth/login/", {"email": "boss@x.test", "password": "pass12345"}, format="json")
        assert api.status_code == 429
        response, _ = self.admin_login("boss@x.test", "pass12345")
        assert "Too many failed login attempts" in response.content.decode()

    def test_success_clears_the_counter(self, staff):
        from django.core.cache import cache

        for _ in range(3):
            self.admin_login("boss@x.test", "wrong")
        response, client = self.admin_login("boss@x.test", "pass12345")
        assert response.status_code == 302 and client.get("/admin/").status_code == 200
        assert cache.get(failure_key("boss@x.test")) is None

    def test_valid_non_staff_credentials_are_not_counted(self, make_user):
        from django.core.cache import cache

        make_user("plain@x.test")
        response, _ = self.admin_login("plain@x.test", "pass12345")
        assert response.status_code == 200  # refused: not staff
        assert cache.get(failure_key("plain@x.test")) is None


# ================================================ 3-5. CORS, HSTS, HTTPS redirect

def test_cors_defaults():
    prod = json.loads(settings_in_subprocess(DJANGO_DEBUG="False").stdout)
    dev = json.loads(settings_in_subprocess(DJANGO_DEBUG="True").stdout)
    assert prod["CORS_ALLOWED_ORIGINS"] == []
    assert dev["CORS_ALLOWED_ORIGINS"] == ["http://localhost:5173", "http://127.0.0.1:5173"]
    explicit = json.loads(settings_in_subprocess(DJANGO_DEBUG="False", CORS_ALLOWED_ORIGINS="https://a.test").stdout)
    assert explicit["CORS_ALLOWED_ORIGINS"] == ["https://a.test"]


def test_hsts_subdomains_and_preload_are_separate_opt_ins():
    values = json.loads(settings_in_subprocess(DJANGO_DEBUG="False", DJANGO_HSTS_SECONDS="31536000").stdout)
    assert values["SECURE_HSTS_SECONDS"] == 31536000
    assert values["SECURE_HSTS_INCLUDE_SUBDOMAINS"] is False and values["SECURE_HSTS_PRELOAD"] is False
    opted = json.loads(settings_in_subprocess(DJANGO_HSTS_SECONDS="60", DJANGO_HSTS_INCLUDE_SUBDOMAINS="True",
                                              DJANGO_HSTS_PRELOAD="True").stdout)
    assert opted["SECURE_HSTS_INCLUDE_SUBDOMAINS"] is True and opted["SECURE_HSTS_PRELOAD"] is True


def test_https_redirect_exempts_only_the_health_check(settings):
    settings.SECURE_SSL_REDIRECT = True
    client = Client()  # built after the override, so SecurityMiddleware reads it
    assert client.get("/api/health/").status_code == 200
    redirected = client.get("/api/auth/me/")
    assert redirected.status_code == 301 and redirected["Location"].startswith("https://")
    assert client.get("/admin/login/").status_code == 301
    assert settings.SECURE_REDIRECT_EXEMPT == [r"^api/health/$"]


def test_proxy_https_header_is_honoured(settings):
    settings.SECURE_SSL_REDIRECT = True
    settings.SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    client = Client()
    assert client.get("/api/auth/me/", HTTP_X_FORWARDED_PROTO="https").status_code == 401  # served, not redirected


def test_production_compose_pins_the_secure_defaults():
    compose = (BACKEND.parent / "docker-compose.prod.yml").read_text(encoding="utf-8")
    for line in ("API_DOCS: ${API_DOCS:-off}", "CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:-}",
                 "DJANGO_SECURE_SSL_REDIRECT: ${DJANGO_SECURE_SSL_REDIRECT:-True}",
                 "DJANGO_HSTS_SECONDS: ${DJANGO_HSTS_SECONDS:-31536000}", "ADMIN_ALLOWLIST: ${ADMIN_ALLOWLIST:-}",
                 'DJANGO_DEBUG: "False"'):
        assert line in compose, line
    assert "DJANGO_HSTS_INCLUDE_SUBDOMAINS:" not in compose and "DJANGO_HSTS_PRELOAD:" not in compose
