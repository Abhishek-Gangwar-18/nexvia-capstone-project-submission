"""Schema review, table #1 (accounts_user): exact email lookups, deactivated users, updated_at."""
import time

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.accounts.models import User
from apps.issues.activity import mentioned_members
from apps.issues.models import Issue
from apps.tenants.models import Invitation, Membership

pytestmark = pytest.mark.django_db
Role = Membership.Role


def user_email_sql(queries):
    return [q["sql"] for q in queries.captured_queries if '"accounts_user"."email"' in q["sql"]]


# ------------------------------------------------------------------- 1. exact lookups

class TestExactEmailLookups:
    def test_register_duplicate_check_is_exact_and_still_case_insensitive(self, api, make_user):
        make_user("taken@x.test")
        with CaptureQueriesContext(connection) as queries:
            res = api().post("/api/auth/register/",
                             {"email": "  TAKEN@X.test ", "password": "S3cure-pass!", "first_name": "T"}, format="json")
        assert res.status_code == 400 and "email" in res.data
        sql = user_email_sql(queries)
        assert sql and not any('UPPER("accounts_user"."email"' in s for s in sql)

    def test_password_reset_matches_any_casing(self, api, make_user, mailoutbox):
        make_user("reset@x.test")
        with CaptureQueriesContext(connection) as queries:
            assert api().post("/api/auth/password-reset/", {"email": "Reset@X.TEST"}, format="json").status_code == 204
        assert len(mailoutbox) == 1
        assert not any("UPPER(" in s for s in user_email_sql(queries))

    def test_invite_member_check_and_preview(self, api, tenant_a, make_user, add_member):
        member = make_user("member@x.test")
        add_member(tenant_a["workspace"], member, Role.MEMBER)
        owner = api(tenant_a["owner"], tenant_a["workspace"])
        res = owner.post("/api/invitations/", {"email": "MEMBER@x.test", "role": "member"}, format="json")
        assert res.status_code == 400 and "already a member" in str(res.data["email"])
        make_user("existing@x.test")
        invite = Invitation.objects.create(workspace=tenant_a["workspace"], email="existing@x.test")
        raw = invite.issue_token()
        invite.save(update_fields=["token_hash"])
        assert api().get(f"/api/invitations/preview/{raw}/").data["user_exists"] is True

    def test_exact_lookup_seeks_the_unique_index(self):
        with connection.cursor() as cur:
            cur.execute("SET LOCAL enable_seqscan = off")
            cur.execute("EXPLAIN SELECT 1 FROM accounts_user WHERE email = %s", ["a@x.test"])
            exact = "\n".join(r[0] for r in cur.fetchall())
            cur.execute("EXPLAIN SELECT 1 FROM accounts_user WHERE UPPER(email::text) = UPPER(%s)", ["a@x.test"])
            upper = "\n".join(r[0] for r in cur.fetchall())
        assert "Index Cond" in exact and "Index Cond" not in upper


# --------------------------------------------------------------- 2. deactivated users

class TestDeactivatedUsers:
    @pytest.fixture
    def gone(self, tenant_a, make_user, add_member):
        user = make_user("gone@x.test")
        add_member(tenant_a["workspace"], user, Role.MEMBER)
        User.objects.filter(pk=user.pk).update(is_active=False)
        user.refresh_from_db()
        return user

    def test_cannot_be_newly_assigned_or_made_lead(self, api, tenant_a, gone):
        client = api(tenant_a["owner"], tenant_a["workspace"])
        res = client.post("/api/issues/", {"project": tenant_a["project"].pk, "title": "x", "assignee": gone.pk},
                          format="json")
        assert res.status_code == 400 and "assignee" in res.data
        res = client.patch(f"/api/projects/{tenant_a['project'].key}/", {"lead": gone.pk}, format="json")
        assert res.status_code == 400 and "lead" in res.data

    def test_existing_assignment_stays_valid(self, api, tenant_a, gone):
        issue = Issue.objects.create(project=tenant_a["project"], title="kept")
        Issue.objects.filter(pk=issue.pk).update(assignee=gone)  # assigned before the deactivation
        client = api(tenant_a["owner"], tenant_a["workspace"])
        res = client.patch(f"/api/issues/{issue.key}/", {"assignee": gone.pk, "title": "renamed"}, format="json")
        assert res.status_code == 200 and res.data["assignee"] == gone.pk

    def test_not_mentioned(self, tenant_a, gone):
        assert mentioned_members(tenant_a["workspace"], f"ping @{gone.email} and @{tenant_a['owner'].email}") == [
            tenant_a["owner"]]

    def test_still_listed_with_flag(self, api, tenant_a, gone):
        members = api(tenant_a["owner"], tenant_a["workspace"]).get("/api/members/").data
        row = next(m for m in members if m["user"]["id"] == gone.pk)
        assert row["user"]["is_active"] is False


# ----------------------------------------------------------------------- 4. updated_at

def test_updated_at_moves_on_profile_change_but_not_on_login(api, make_user):
    user = make_user("stamp@x.test")
    first = User.objects.get(pk=user.pk).updated_at
    time.sleep(0.01)
    assert api().post("/api/auth/login/", {"email": "stamp@x.test", "password": "pass12345"}, format="json").status_code == 200
    after_login = User.objects.get(pk=user.pk)
    assert after_login.last_login is not None and after_login.updated_at == first
    api(user).patch("/api/auth/me/", {"job_title": "Lead"}, format="json")
    assert User.objects.get(pk=user.pk).updated_at > first
