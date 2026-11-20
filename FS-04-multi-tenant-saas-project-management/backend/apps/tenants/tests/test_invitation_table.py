"""Schema review, table #4 (tenants_invitation): lowercase emails with an exact-match index, hashed tokens,
one-time links, the "joined" audit record, retention of accepted invites, and concurrent invites."""
import hashlib
import threading
from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from django.core import mail
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.automation.tasks import purge_expired_invitations, send_invitation_email
from apps.issues.models import AuditLog
from apps.tenants.models import Invitation, Workspace

Role = "member"


def invite_api(api, tenant, email, role="member"):
    return api(tenant["owner"], tenant["workspace"]).post("/api/invitations/", {"email": email, "role": role}, format="json")


def raw_of(response):
    return response.data["accept_url"].rsplit("/", 1)[1]


@pytest.fixture
def paid(tenant_a):
    tenant_a["workspace"].plan = Workspace.Plan.ENTERPRISE  # no seat cap in these tests
    tenant_a["workspace"].save(update_fields=["plan"])
    return tenant_a


# ------------------------------------------------------------------ 1. lowercase emails

@pytest.mark.django_db
class TestEmails:
    def test_stored_lowercase_and_enforced_by_db(self, paid):
        invite = Invitation.objects.create(workspace=paid["workspace"], email="  Mixed@Case.TEST ")
        assert Invitation.objects.get(pk=invite.pk).email == "mixed@case.test"
        with pytest.raises(IntegrityError), transaction.atomic():
            Invitation.objects.filter(pk=invite.pk).update(email="Mixed@Case.TEST")

    def test_duplicate_check_is_exact_and_still_case_insensitive(self, api, paid):
        assert invite_api(api, paid, "dup@x.test").status_code == 201
        with CaptureQueriesContext(connection) as queries:
            res = invite_api(api, paid, "DUP@X.test")
        assert res.status_code == 400 and "already pending" in str(res.data["email"])
        invite_sql = [q["sql"] for q in queries.captured_queries if '"tenants_invitation"."email"' in q["sql"]]
        assert invite_sql and not any("UPPER(" in s for s in invite_sql)

    def test_unique_index_is_plain_and_seeks_on_email(self, paid):
        with connection.cursor() as cur:
            cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'unique_open_invitation'")
            definition = cur.fetchone()[0]
            cur.execute("SET LOCAL enable_seqscan = off")
            cur.execute("EXPLAIN SELECT 1 FROM tenants_invitation WHERE workspace_id = %s AND email = %s "
                        "AND accepted_at IS NULL", [paid["workspace"].pk, "a@x.test"])
            plan = "\n".join(r[0] for r in cur.fetchall())
        assert "(workspace_id, email)" in definition and "lower(" not in definition.lower()
        assert "Index Cond: ((workspace_id = " in plan and "email" in plan.split("Index Cond:")[1].splitlines()[0]


# ------------------------------------------------------------------- 2. hashed tokens

@pytest.mark.django_db
class TestHashedTokens:
    def test_no_plaintext_column_and_no_pattern_index(self):
        with connection.cursor() as cur:
            cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'tenants_invitation'")
            columns = {r[0] for r in cur.fetchall()}
            cur.execute("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'tenants_invitation'")
            indexes = cur.fetchall()
        assert "token" not in columns and "token_hash" in columns
        token_indexes = [name for name, d in indexes if "token" in d]
        assert token_indexes == ["uq_invitation_token_hash"]  # one unique index, no varchar_pattern_ops twin

    def test_link_only_in_create_response_hash_never_exposed(self, api, paid):
        created = invite_api(api, paid, "once@x.test")
        raw = raw_of(created)
        invitation = Invitation.objects.get(email="once@x.test")
        assert invitation.token_hash == hashlib.sha256(raw.encode()).hexdigest()
        listed = api(paid["owner"], paid["workspace"]).get("/api/invitations/").data
        assert listed[0]["accept_url"] is None
        for payload in (created.data, listed):
            assert invitation.token_hash not in str(payload) and "token_hash" not in str(payload)

    def test_preview_accept_and_register_use_the_raw_token(self, api, paid, make_user):
        raw = raw_of(invite_api(api, paid, "joiner@x.test"))
        assert api().get(f"/api/invitations/preview/{raw}/").status_code == 200
        assert api().get(f"/api/invitations/preview/{raw[:-2]}xx/").status_code == 404
        res = api().post("/api/auth/register/", {"email": "joiner@x.test", "password": "S3cure-pass!",
                                                 "first_name": "J", "invite_token": raw}, format="json")
        assert res.status_code == 201 and res.data["workspace"] == paid["workspace"].slug
        hashed = Invitation.objects.get(email="joiner@x.test").token_hash
        res = api(make_user("other@x.test")).post("/api/invitations/accept/", {"token": hashed}, format="json")
        assert res.status_code == 400  # the stored hash is not itself a working token

    def test_resend_rotates_the_link_and_skips_stale_emails(self, api, paid, monkeypatch):
        monkeypatch.setattr("apps.tenants.views.enqueue", MagicMock(return_value=None))
        old = raw_of(invite_api(api, paid, "rotate@x.test"))
        invitation = Invitation.objects.get(email="rotate@x.test")
        res = api(paid["owner"], paid["workspace"]).post(f"/api/invitations/{invitation.pk}/resend/")
        assert res.status_code == 202
        new = raw_of(res)
        assert new != old
        assert api().get(f"/api/invitations/preview/{old}/").status_code == 404
        assert api().get(f"/api/invitations/preview/{new}/").status_code == 200
        send_invitation_email.apply(args=(invitation.pk, old), throw=True)  # a still-queued email from before
        assert mail.outbox == []
        send_invitation_email.apply(args=(invitation.pk, new), throw=True)
        assert len(mail.outbox) == 1 and new in mail.outbox[0].body


# ------------------------------------------------------- 3. joined record and retention

@pytest.mark.django_db
class TestRetention:
    def test_joined_event_keeps_inviter_and_times(self, api, paid):
        raw = raw_of(invite_api(api, paid, "rec@x.test"))
        api().post("/api/auth/register/", {"email": "rec@x.test", "password": "S3cure-pass!", "first_name": "R",
                                           "invite_token": raw}, format="json")
        event = AuditLog.objects.get(workspace=paid["workspace"], action="joined")
        assert event.entity_label == "rec@x.test" and event.actor.email == "rec@x.test"
        assert event.changes["invited_by"] == {"id": paid["owner"].pk, "email": paid["owner"].email}
        assert event.changes["invited_at"] and event.changes["role"] == "member"

    def test_accepted_invites_purged_after_30_days(self, paid):
        now = timezone.now()
        ws = paid["workspace"]
        old_accepted = Invitation.objects.create(workspace=ws, email="a1@x.test", accepted_at=now - timedelta(days=31))
        new_accepted = Invitation.objects.create(workspace=ws, email="a2@x.test", accepted_at=now - timedelta(days=5))
        old_expired = Invitation.objects.create(workspace=ws, email="e1@x.test", expires_at=now - timedelta(days=31))
        pending = Invitation.objects.create(workspace=ws, email="p1@x.test")
        assert purge_expired_invitations() == 2
        assert set(Invitation.objects.values_list("pk", flat=True)) == {new_accepted.pk, pending.pk}
        assert not Invitation.objects.filter(pk__in=[old_accepted.pk, old_expired.pk]).exists()


# --------------------------------------------------------------- concurrent invites

@pytest.mark.django_db(transaction=True)
def test_concurrent_invites_for_one_email_create_one(paid):
    from rest_framework.test import APIClient

    codes = []

    def invite():
        client = APIClient()
        client.force_authenticate(paid["owner"])
        client.credentials(HTTP_X_WORKSPACE=paid["workspace"].slug)
        codes.append(client.post("/api/invitations/", {"email": "race@x.test", "role": "member"}, format="json").status_code)
        connection.close()

    threads = [threading.Thread(target=invite) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes) == [201, 400, 400, 400]
    assert Invitation.objects.filter(email="race@x.test").count() == 1


# ------------------------------------------------- migration keeps pending links alive

@pytest.mark.django_db(transaction=True)
def test_migration_hashes_existing_tokens_so_old_links_still_work(api):
    from django.db.migrations.executor import MigrationExecutor

    from apps.accounts.models import User

    owner = User.objects.create_user("mig@x.test", "pass12345")  # current models: these tables don't change
    ws = Workspace.objects.create(name="Mig", slug="mig", owner=owner)
    before = [("tenants", "0007_membership_no_default_ordering")]
    executor = MigrationExecutor(connection)
    try:
        # Unapplies tenants 0008 *and every migration that depends on it* (other apps' later migrations
        # reference tenants 0008), so the database and the historical models describe one consistent state.
        executor.migrate(before)
        OldInvitation = executor.loader.project_state(before).apps.get_model("tenants", "Invitation")
        OldInvitation.objects.create(workspace_id=ws.pk, email="Pending@X.test", token="legacy-plain-token",
                                     expires_at=timezone.now() + timedelta(days=3))
    finally:
        # Always return to the latest schema, even if a step above failed, so no later test inherits a
        # half-migrated database.
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())
    migrated = Invitation.objects.get(workspace_id=ws.pk)
    assert migrated.email == "pending@x.test"
    assert migrated.token_hash == hashlib.sha256(b"legacy-plain-token").hexdigest()
    assert api().get("/api/invitations/preview/legacy-plain-token/").status_code == 200


@pytest.mark.django_db(transaction=True)
def test_concurrent_resends_issue_exactly_one_working_link(paid, monkeypatch):
    """The resend row lock + cooldown must hold now that a resend also rotates the token: two parallel resends
    give one 202 and one 429, and only the 202's link works (no second 'valid' link handed out)."""
    from rest_framework.test import APIClient

    monkeypatch.setattr("apps.tenants.views.enqueue", MagicMock(return_value=None))
    invitation = Invitation.objects.create(workspace=paid["workspace"], email="resend-race@x.test",
                                           invited_by=paid["owner"])
    results, start = [], threading.Barrier(2)

    def resend():
        client = APIClient()
        client.force_authenticate(paid["owner"])
        client.credentials(HTTP_X_WORKSPACE=paid["workspace"].slug)
        start.wait()
        res = client.post(f"/api/invitations/{invitation.pk}/resend/")
        results.append((res.status_code, res.data.get("accept_url") if res.status_code == 202 else None))
        connection.close()

    threads = [threading.Thread(target=resend) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(code for code, _ in results) == [202, 429]
    link = next(url for code, url in results if code == 202)
    raw = link.rsplit("/", 1)[1]
    invitation.refresh_from_db()
    assert invitation.token_hash == hashlib.sha256(raw.encode()).hexdigest()
