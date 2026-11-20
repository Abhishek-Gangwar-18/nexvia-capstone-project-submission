"""Schema review, table #6 (issues_auditlog): history outlives projects, trigram search, index-friendly date
range, exact project filter, no updated_at, read-only admin."""
from datetime import date, datetime, time, timedelta, timezone as dt_tz
from unittest.mock import MagicMock

import pytest
from django.contrib.admin.sites import site
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.automation.tasks import process_issue_event
from apps.issues.models import AuditLog, Issue
from apps.projects.services import create_project

pytestmark = pytest.mark.django_db


def owner_client(api, tenant):
    return api(tenant["owner"], tenant["workspace"])


def event(ws, **extra):
    return AuditLog.objects.create(workspace=ws, action="updated", entity_type="issue", **extra)


# ------------------------------------------------------------- 1. history outlives projects

class TestProjectReference:
    def test_no_fk_constraint_and_no_index_on_project_id(self):
        with connection.cursor() as cur:
            cur.execute("""SELECT count(*) FROM pg_constraint WHERE conrelid = 'issues_auditlog'::regclass
                           AND contype = 'f' AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute
                           WHERE attrelid = 'issues_auditlog'::regclass AND attname = 'project_id')]""")
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT indexdef FROM pg_indexes WHERE tablename = 'issues_auditlog'")
            assert not any(d.endswith("btree (project_id)") for (d,) in cur.fetchall())

    def test_deleting_a_project_leaves_its_history_untouched(self, api, tenant_a):
        ws = tenant_a["workspace"]
        project = create_project(workspace=ws, name="Gone", key="GONE", created_by=tenant_a["owner"])
        kept = event(ws, project=project, issue_key="GONE-1", issue_title="t")
        with CaptureQueriesContext(connection) as queries:
            assert owner_client(api, tenant_a).delete("/api/projects/GONE/", {"confirm": "GONE"},
                                                      format="json").status_code == 204
        assert not any(q["sql"].startswith('UPDATE "issues_auditlog"') for q in queries.captured_queries)
        kept.refresh_from_db()
        assert (kept.project_id, kept.project_key) == (project.pk, "GONE")
        res = owner_client(api, tenant_a).get("/api/audit-log/?project=GONE&page=1")
        assert res.status_code == 200 and any(e["issue_key"] == "GONE-1" for e in res.data["results"])

    def test_webhook_fan_out_tolerates_a_deleted_project(self, tenant_a, monkeypatch):
        monkeypatch.setattr("apps.automation.tasks.enqueue", MagicMock(return_value=None))
        ws = tenant_a["workspace"]
        project = create_project(workspace=ws, name="Gone", key="GONE", created_by=tenant_a["owner"])
        audit = event(ws, project=project, issue_key="GONE-1", issue_title="t", actor=tenant_a["owner"],
                      entity_label="GONE-1 t")
        project.delete()
        process_issue_event(audit.pk)  # must not raise


# ------------------------------------------------------------------------ 2. search

class TestSearch:
    def test_trigram_index_on_the_searched_expression(self, tenant_a):
        for i in range(30):
            event(tenant_a["workspace"], entity_label=f"WEB-{i} padding text {i}")
        event(tenant_a["workspace"], entity_label="WEB-99 needle-xyz")
        with connection.cursor() as cur:
            cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'auditlog_entity_label_trgm'")
            assert "gin (upper((entity_label)::text) gin_trgm_ops)" in cur.fetchone()[0]
            # The expression alone (no workspace filter) so only an index *on that expression* can serve it:
            # this proves the index matches what Django's icontains emits. (With a workspace filter on a tiny
            # table the planner rightly prefers the workspace index; the 200k-row benchmark showed 0.16 ms here.)
            cur.execute("SET LOCAL enable_seqscan = off")
            cur.execute("EXPLAIN SELECT id FROM issues_auditlog WHERE UPPER(entity_label::text) LIKE UPPER(%s)",
                        ["%needle-xyz%"])
            assert "auditlog_entity_label_trgm" in "\n".join(r[0] for r in cur.fetchall())

    def test_short_terms_still_work(self, api, tenant_a):
        event(tenant_a["workspace"], entity_label="WEB-1 Login bug")
        for term in ("l", "lo", "login"):
            res = owner_client(api, tenant_a).get(f"/api/audit-log/?search={term}&page=1")
            assert any("Login bug" in e["entity_label"] for e in res.data["results"]), term


# --------------------------------------------------------------- 3. date range filters

class TestDateFilters:
    def test_same_records_as_date_lookup_on_the_boundaries(self, api, tenant_a):
        ws = tenant_a["workspace"]
        day = date(2026, 6, 15)
        stamps = {
            "prev-last": datetime.combine(day - timedelta(days=1), time(23, 59, 59, 999999), dt_tz.utc),
            "first": datetime.combine(day, time(0, 0), dt_tz.utc),
            "last": datetime.combine(day, time(23, 59, 59, 999999), dt_tz.utc),
            "next-first": datetime.combine(day + timedelta(days=1), time(0, 0), dt_tz.utc),
        }
        ids = {}
        for label, ts in stamps.items():
            row = event(ws, entity_label=label)
            AuditLog.objects.filter(pk=row.pk).update(created_at=ts)
            ids[row.pk] = label
        client = owner_client(api, tenant_a)
        for query in (f"date_from={day}", f"date_to={day}", f"date_from={day}&date_to={day}"):
            got = {e["entity_label"] for e in client.get(f"/api/audit-log/?{query}&page=1&page_size=200").data["results"]
                   if e["id"] in ids}
            old = AuditLog.objects.filter(pk__in=ids)
            if "date_from" in query:
                old = old.filter(created_at__date__gte=day)
            if "date_to" in query:
                old = old.filter(created_at__date__lte=day)
            assert got == {ids[pk] for pk in old.values_list("pk", flat=True)}, query

    def test_sql_has_no_date_cast(self, api, tenant_a):
        with CaptureQueriesContext(connection) as queries:
            owner_client(api, tenant_a).get("/api/audit-log/?date_from=2026-01-01&date_to=2026-01-31")
        audit_sql = [q["sql"] for q in queries.captured_queries if 'FROM "issues_auditlog"' in q["sql"]]
        assert audit_sql and not any("AT TIME ZONE" in s or "::date" in s for s in audit_sql)

    def test_bad_date_is_still_a_400(self, api, tenant_a):
        assert owner_client(api, tenant_a).get("/api/audit-log/?date_from=nope").status_code == 400


# ------------------------------------------------------------- 4. project filter, exact

def test_project_filter_is_case_insensitive_input_exact_sql(api, tenant_a):
    event(tenant_a["workspace"], project_key="WEB", entity_label="x")
    with CaptureQueriesContext(connection) as queries:
        res = owner_client(api, tenant_a).get("/api/audit-log/?project=web&page=1")
    assert res.data["count"] >= 1
    audit_sql = [q["sql"] for q in queries.captured_queries if 'FROM "issues_auditlog"' in q["sql"]]
    assert not any('UPPER("issues_auditlog"."project_key"' in s for s in audit_sql)
    assert owner_client(api, tenant_a).get("/api/audit-log/?project=nope&page=1").data["count"] == 0


# ------------------------------------------------- 5. append-only: no updated_at, admin

def test_no_updated_at_column():
    with connection.cursor() as cur:
        cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'issues_auditlog'")
        columns = {r[0] for r in cur.fetchall()}
    assert "updated_at" not in columns and "created_at" in columns


def test_admin_is_read_only(rf, make_user):
    staff = make_user("staff@x.test", is_staff=True, is_superuser=True)
    request = rf.get("/")
    request.user = staff
    admin = site._registry[AuditLog]
    assert not admin.has_add_permission(request)
    assert not admin.has_change_permission(request)
    assert not admin.has_delete_permission(request)
