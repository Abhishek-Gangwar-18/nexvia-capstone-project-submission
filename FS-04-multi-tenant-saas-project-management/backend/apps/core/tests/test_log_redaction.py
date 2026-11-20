"""Phase 4 (M1/L1): reset and invitation secrets never reach the logs."""
import logging

import pytest

from apps.core.request_logging import REDACTED, RedactSecretPaths, redact_path

pytestmark = pytest.mark.django_db
SECRET = "s3cr3t-T0ken_value"


@pytest.mark.parametrize("path, expected", [
    (f"/reset-password/MQ/{SECRET}", f"/reset-password/{REDACTED}"),
    (f"/invite/{SECRET}", f"/invite/{REDACTED}"),
    (f"/api/invitations/preview/{SECRET}/", f"/api/invitations/preview/{REDACTED}"),
    (f"/API/Invitations/Preview/{SECRET}/?x=1", f"/API/Invitations/Preview/{REDACTED}?x=1"),
    (f"/login?next=%2Finvite%2F{SECRET}", f"/login?next=%2Finvite%2F{REDACTED}"),
    (f"/login?next=/reset-password/MQ/{SECRET}&a=b", f"/login?next=/reset-password/{REDACTED}&a=b"),
    (f"/api/x/?token={SECRET}&page=2", f"/api/x/?token={REDACTED}&page=2"),
    (f"/api/x/?page=2&uid=MQ&code={SECRET}", f"/api/x/?page=2&uid={REDACTED}&code={REDACTED}"),
])
def test_secret_parts_are_masked(path, expected):
    assert redact_path(path) == expected
    assert SECRET not in redact_path(path)


@pytest.mark.parametrize("path", [
    "/api/projects/", "/api/issues/WEB-4/move/", "/api/issues/?search=invite&page=2",
    "/api/invitations/accept/", "/w/acme/settings/invites", "/api/workspaces/?ordering=-created_at",
])
def test_ordinary_paths_are_unchanged(path):
    assert redact_path(path) == path


def _access(caplog):
    return [r for r in caplog.records if r.name == "flowboard.request"]


def test_invite_preview_request_is_logged_redacted(caplog):
    from rest_framework.test import APIClient
    caplog.set_level(logging.INFO, logger="flowboard.request")
    res = APIClient().get(f"/api/invitations/preview/{SECRET}/?token={SECRET}")
    [record] = _access(caplog)
    line = record.getMessage()
    assert SECRET not in line
    assert f"/api/invitations/preview/{REDACTED}" in line
    # status and timing still logged
    assert record.http_status == res.status_code and str(res.status_code) in line
    assert record.duration_ms >= 0 and "ms" in line


def test_normal_request_keeps_its_path(api, tenant_a, caplog):
    caplog.set_level(logging.INFO, logger="flowboard.request")
    api(tenant_a["owner"], tenant_a["workspace"]).get("/api/projects/?page=1")
    [record] = _access(caplog)
    assert "GET /api/projects/?page=1 200" in record.getMessage()


def test_handler_filter_masks_django_lines():
    """e.g. django.request's 'Internal Server Error: <path>' (args) or any message text."""
    record = logging.LogRecord("django.request", logging.ERROR, __file__, 1,
                               "%s: %s", ("Internal Server Error", f"/invite/{SECRET}"), None)
    plain = logging.LogRecord("x", logging.INFO, __file__, 1, f"opened /reset-password/MQ/{SECRET}", None, None)
    for r in (record, plain):
        assert RedactSecretPaths().filter(r) is True
        assert SECRET not in r.getMessage()


def test_filter_is_installed_on_the_console_handler():
    from django.conf import settings
    assert "redact_secrets" in settings.LOGGING["handlers"]["console"]["filters"]
