"""Phase 2: browser refresh token in an httpOnly cookie (X-Auth-Mode: cookie); body mode unchanged."""
import pytest
from django.test import override_settings
from rest_framework.test import APIClient
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts.cookie_auth import COOKIE_NAME, COOKIE_PATH

pytestmark = pytest.mark.django_db
COOKIE = {"HTTP_X_AUTH_MODE": "cookie"}
PASSWORD = "pass12345"


@pytest.fixture
def user(make_user):
    return make_user("cookie@x.test")


def login(client, email="cookie@x.test", **extra):
    return client.post("/api/auth/login/", {"email": email, "password": PASSWORD}, format="json", **extra)


def cookie_of(response):
    return response.cookies.get(COOKIE_NAME)


# ------------------------------------------------------------------ issuing

class TestIssuing:
    def test_login_cookie_mode_sets_cookie_and_keeps_token_out_of_body(self, user):
        res = login(APIClient(), **COOKIE)
        assert res.status_code == 200 and "access" in res.data and "refresh" not in res.data
        c = cookie_of(res)
        assert c and c.value
        assert c["httponly"] is True and c["samesite"] == "Strict" and c["path"] == COOKIE_PATH
        assert int(c["max-age"]) == 7 * 24 * 3600
        assert c["secure"] == ""  # dev / tests: secure cookies off

    @override_settings(SESSION_COOKIE_SECURE=True)
    def test_cookie_is_secure_in_production(self, user):
        assert cookie_of(login(APIClient(), **COOKIE))["secure"] is True

    def test_body_mode_unchanged(self, user):
        res = login(APIClient())
        assert {"access", "refresh"} <= set(res.data) and cookie_of(res) is None

    def test_register_and_change_password_follow_the_mode(self, make_user):
        client = APIClient()
        reg = client.post("/api/auth/register/", {"email": "new@x.test", "password": "Str0ng-pass!x", "first_name": "N",
                                                  "workspace_name": "N"}, format="json", **COOKIE)
        assert reg.status_code == 201 and "refresh" not in reg.data and cookie_of(reg)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {reg.data['access']}")
        changed = client.post("/api/auth/change-password/", {"current_password": "Str0ng-pass!x",
                                                             "new_password": "An0ther-pass!y"}, format="json", **COOKIE)
        assert changed.status_code == 200 and "refresh" not in changed.data and cookie_of(changed)
        body = APIClient()
        body.credentials(HTTP_AUTHORIZATION=f"Bearer {changed.data['access']}")
        again = body.post("/api/auth/change-password/", {"current_password": "An0ther-pass!y",
                                                          "new_password": "Thi3d-pass!z"}, format="json")
        assert "refresh" in again.data and cookie_of(again) is None


# ------------------------------------------------------------------ refreshing

class TestRefresh:
    def test_rotation_through_the_cookie_only(self, user):
        client = APIClient()
        first = cookie_of(login(client, **COOKIE)).value
        res = client.post("/api/auth/refresh/", {}, format="json", **COOKIE)
        assert res.status_code == 200 and "access" in res.data and "refresh" not in res.data
        second = cookie_of(res).value
        assert second != first
        # the old cookie value is blacklisted after rotation
        stale = APIClient()
        stale.cookies[COOKIE_NAME] = first
        assert stale.post("/api/auth/refresh/", {}, format="json", **COOKIE).status_code == 401

    def test_missing_cookie_never_falls_back_to_a_body_token(self, user):
        body_token = login(APIClient()).data["refresh"]
        res = APIClient().post("/api/auth/refresh/", {"refresh": body_token}, format="json", **COOKIE)
        assert res.status_code == 401 and res.data["code"] == "no_refresh_cookie" and "access" not in res.data
        assert not BlacklistedToken.objects.exists()  # the body token wasn't touched

    def test_body_token_is_ignored_when_a_cookie_exists(self, user):
        client = APIClient()
        login(client, **COOKIE)
        other = login(APIClient()).data["refresh"]
        res = client.post("/api/auth/refresh/", {"refresh": other}, format="json", **COOKIE)
        assert res.status_code == 200
        assert not BlacklistedToken.objects.filter(token__token=other).exists()  # only the cookie's rotated

    @pytest.mark.parametrize("value", ["garbage", "a.b.c"])
    def test_invalid_cookie_rejected_and_cleared(self, user, value):
        client = APIClient()
        client.cookies[COOKIE_NAME] = value
        res = client.post("/api/auth/refresh/", {}, format="json", **COOKIE)
        assert res.status_code == 401 and cookie_of(res).value == "" and int(cookie_of(res)["max-age"]) == 0

    def test_cookie_without_the_header_is_not_used(self, user):
        """Cross-origin pages can't send the custom header without a CORS preflight; without it the cookie is
        ignored, so a forged request gets body-mode semantics (no token in the body -> 400)."""
        client = APIClient()
        login(client, **COOKIE)
        res = client.post("/api/auth/refresh/", {}, format="json")
        assert res.status_code == 400 and "access" not in res.data

    def test_body_mode_refresh_unchanged(self, user):
        token = login(APIClient()).data["refresh"]
        res = APIClient().post("/api/auth/refresh/", {"refresh": token}, format="json")
        assert res.status_code == 200 and {"access", "refresh"} <= set(res.data) and cookie_of(res) is None

    def test_no_other_endpoint_accepts_the_cookie(self, user):
        client = APIClient()
        login(client, **COOKIE)
        for url in ("/api/auth/me/", "/api/workspaces/"):
            assert client.get(url, **COOKIE).status_code == 401


# ------------------------------------------------------------------ logout

class TestLogout:
    def test_logout_revokes_and_clears_with_the_same_attributes(self, user):
        client = APIClient()
        raw = cookie_of(login(client, **COOKIE)).value
        res = client.post("/api/auth/logout/", {}, format="json", **COOKIE)
        assert res.status_code == 204
        cleared = cookie_of(res)
        assert cleared.value == "" and int(cleared["max-age"]) == 0
        assert cleared["path"] == COOKIE_PATH and cleared["samesite"] == "Strict"
        assert BlacklistedToken.objects.filter(token__jti=RefreshToken(raw, verify=False)["jti"]).exists()
        reuse = APIClient()
        reuse.cookies[COOKIE_NAME] = raw
        assert reuse.post("/api/auth/refresh/", {}, format="json", **COOKIE).status_code == 401

    def test_logout_is_idempotent_without_a_cookie(self):
        assert APIClient().post("/api/auth/logout/", {}, format="json", **COOKIE).status_code == 204

    def test_logout_all_clears_the_cookie_and_keeps_access_semantics(self, user):
        client = APIClient()
        data = login(client, **COOKIE).data
        other = login(APIClient()).data["refresh"]  # a second device, body mode
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {data['access']}")
        res = client.post("/api/auth/logout-all/", {}, format="json", **COOKIE)
        assert res.status_code == 204 and cookie_of(res).value == ""
        assert APIClient().post("/api/auth/refresh/", {"refresh": other}, format="json").status_code == 401
        assert client.get("/api/auth/me/").status_code == 200  # issued access tokens live until they expire

    def test_body_mode_logout_unchanged(self, user):
        token = login(APIClient()).data["refresh"]
        assert APIClient().post("/api/auth/logout/", {}, format="json").status_code == 400
        assert APIClient().post("/api/auth/logout/", {"refresh": token}, format="json").status_code == 204


def test_cross_origin_preflight_for_the_header_is_refused(user):
    """A page on another origin must preflight X-Auth-Mode; with no allowed origins it gets no CORS grant, so the
    browser never sends the cookie-mode request."""
    res = APIClient().options("/api/auth/refresh/", HTTP_ORIGIN="https://evil.example",
                              HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
                              HTTP_ACCESS_CONTROL_REQUEST_HEADERS="x-auth-mode, content-type")
    assert "access-control-allow-origin" not in {k.lower() for k in res.headers}
    assert "access-control-allow-credentials" not in {k.lower() for k in res.headers}


# ------------------------------------------------ clearing matches creation exactly

ATTRIBUTES = ("path", "domain", "httponly", "secure", "samesite")


@pytest.mark.parametrize("secure", [False, True])
def test_clearing_cookie_repeats_every_creation_attribute(user, secure):
    with override_settings(SESSION_COOKIE_SECURE=secure):
        client = APIClient()
        created = cookie_of(login(client, **COOKIE))
        cleared = cookie_of(client.post("/api/auth/logout/", {}, format="json", **COOKIE))
    assert {a: created[a] for a in ATTRIBUTES} == {a: cleared[a] for a in ATTRIBUTES}
    assert created["secure"] is secure or (not secure and created["secure"] == "")
    assert cleared.value == "" and int(cleared["max-age"]) == 0
    assert cleared["expires"] == "Thu, 01 Jan 1970 00:00:00 GMT"


def test_refresh_failure_clears_with_the_same_attributes(user):
    client = APIClient()
    created = cookie_of(login(client, **COOKIE))
    client.cookies[COOKIE_NAME] = "garbage"
    cleared = cookie_of(client.post("/api/auth/refresh/", {}, format="json", **COOKIE))
    assert {a: created[a] for a in ATTRIBUTES} == {a: cleared[a] for a in ATTRIBUTES}
    assert int(cleared["max-age"]) == 0
