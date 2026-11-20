"""Security hardening, Phase 3: nightly cleanup of expired refresh tokens (SimpleJWT's blacklist tables)."""
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.conf import settings
from django.db import OperationalError
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.automation import tasks
from apps.automation.tasks import flush_expired_tokens

pytestmark = pytest.mark.django_db


def token(user, *, expired, blacklisted=False):
    refresh = RefreshToken.for_user(user)  # records an OutstandingToken
    if blacklisted:
        refresh.blacklist()
    row = OutstandingToken.objects.get(jti=refresh["jti"])
    if expired:
        OutstandingToken.objects.filter(pk=row.pk).update(expires_at=timezone.now() - timedelta(minutes=1))
    return row, str(refresh)


@pytest.fixture
def mix(make_user):
    user = make_user("tokens@x.test")
    return {
        "user": user,
        "expired": token(user, expired=True),
        "expired_revoked": token(user, expired=True, blacklisted=True),
        "live": token(user, expired=False),
        "live_revoked": token(user, expired=False, blacklisted=True),
    }


def test_removes_only_expired_tokens_and_their_blacklist_entries(mix):
    assert flush_expired_tokens() == 2
    left = set(OutstandingToken.objects.values_list("pk", flat=True))
    assert left == {mix["live"][0].pk, mix["live_revoked"][0].pk}
    # the revoked-but-not-expired token stays revoked
    assert BlacklistedToken.objects.filter(token_id=mix["live_revoked"][0].pk).exists()
    assert BlacklistedToken.objects.count() == 1


def test_revoked_live_token_still_refused_after_cleanup(mix):
    flush_expired_tokens()
    res = APIClient().post("/api/auth/refresh/", {"refresh": mix["live_revoked"][1]}, format="json")
    assert res.status_code == 401
    ok = APIClient().post("/api/auth/refresh/", {"refresh": mix["live"][1]}, format="json")
    assert ok.status_code == 200  # untouched sessions keep working


def test_idempotent(mix):
    assert flush_expired_tokens() == 2
    assert flush_expired_tokens() == 0
    assert OutstandingToken.objects.count() == 2


def test_bounded_batches(mix, monkeypatch):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    monkeypatch.setattr(tasks, "PURGE_BATCH", 2)
    for _ in range(5):
        token(mix["user"], expired=True)
    with CaptureQueriesContext(connection) as queries:
        assert flush_expired_tokens() == 7
    batches = [q["sql"] for q in queries.captured_queries
               if q["sql"].startswith('SELECT "token_blacklist_outstandingtoken"."id"') and q["sql"].endswith("LIMIT 2")]
    assert len(batches) == 5  # 2 + 2 + 2 + 1, then an empty check: never everything in one statement


def test_failure_keeps_progress_and_the_next_run_finishes(mix, monkeypatch):
    monkeypatch.setattr(tasks, "PURGE_BATCH", 1)
    real_delete = OutstandingToken.objects.none().__class__.delete
    calls = {"n": 0}

    def flaky(qs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("database went away")
        return real_delete(qs)

    with patch.object(OutstandingToken.objects.none().__class__, "delete", flaky), pytest.raises(RuntimeError):
        tasks.flush_expired_tokens.run()
    assert OutstandingToken.objects.filter(expires_at__lte=timezone.now()).count() == 1  # first batch committed
    assert flush_expired_tokens() == 1  # the next run completes the job
    assert OutstandingToken.objects.filter(expires_at__lte=timezone.now()).count() == 0


def test_transient_database_errors_are_retried(mix):
    assert OperationalError in flush_expired_tokens.autoretry_for
    assert flush_expired_tokens.max_retries == 3


def test_scheduled_nightly():
    entry = settings.CELERY_BEAT_SCHEDULE["nightly-flush-expired-tokens"]
    assert entry["task"] == "apps.automation.tasks.flush_expired_tokens"
    assert (entry["schedule"].hour, entry["schedule"].minute) == ({3}, {45})
