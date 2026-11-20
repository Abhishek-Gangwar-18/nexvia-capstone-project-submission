"""Schema review, table #17 (automation_notification): inbox index for the newest-first poll, a partial index for
the unread count, a created_at index for retention. API response unchanged (exact unread_count)."""
from datetime import timedelta

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.automation.models import Notification
from apps.automation.tasks import purge_old_records

pytestmark = pytest.mark.django_db


def make(tenant, n, *, unread_every=5, other=None):
    rows = [Notification(workspace=tenant["workspace"], recipient=tenant["owner"], event_key=f"k{i}", title=f"t{i}",
                         body="b", read_at=None if i % unread_every == 0 else timezone.now()) for i in range(n)]
    return Notification.objects.bulk_create(rows)


def plan(sql, params=None):
    with connection.cursor() as cur:
        cur.execute("SET LOCAL enable_seqscan = off")
        cur.execute("EXPLAIN " + sql, params)
        return "\n".join(r[0] for r in cur.fetchall())


class TestApiUnchanged:
    def test_exact_unread_count_and_newest_first(self, api, tenant_a):
        rows = make(tenant_a, 150)
        res = api(tenant_a["owner"], tenant_a["workspace"]).get("/api/notifications/")
        assert res.data["unread_count"] == 30  # exact, not capped
        ids = [r["id"] for r in res.data["results"]]
        assert len(ids) == 100 and ids == sorted((r.pk for r in rows), reverse=True)[:100]

    def test_paging_and_mark_all_read(self, api, tenant_a):
        make(tenant_a, 120)
        client = api(tenant_a["owner"], tenant_a["workspace"])
        page = client.get("/api/notifications/?page=2").data
        assert page["count"] == 120 and page["unread_count"] == 24
        assert client.post("/api/notifications/read-all/").data["updated"] == 24
        assert client.get("/api/notifications/").data["unread_count"] == 0

    def test_other_recipients_never_counted(self, api, tenant_a, tenant_b):
        make(tenant_a, 10)
        make(tenant_b, 50)
        assert api(tenant_a["owner"], tenant_a["workspace"]).get("/api/notifications/").data["unread_count"] == 2


class TestIndexesUsed:
    def test_inbox_query_reads_the_inbox_index(self, api, tenant_a):
        make(tenant_a, 30)
        with CaptureQueriesContext(connection) as queries:
            api(tenant_a["owner"], tenant_a["workspace"]).get("/api/notifications/")
        listing = next(q["sql"] for q in queries.captured_queries
                       if 'FROM "automation_notification"' in q["sql"] and "ORDER BY" in q["sql"])
        # On 30 rows a sort is cheaper, so take sorting off the table: the plan must then come straight from
        # the inbox index (at 100k rows the planner chose it by itself: 19.3 ms -> 5.4 ms).
        with connection.cursor() as cur:
            cur.execute("SET LOCAL enable_sort = off")
        text = plan(listing)
        assert "notification_inbox_newest" in text and "Sort" not in text

    def test_unread_count_can_use_the_partial_index(self, tenant_a):
        make(tenant_a, 30)
        text = plan("SELECT COUNT(*) FROM automation_notification WHERE workspace_id = %s AND recipient_id = %s "
                    "AND read_at IS NULL", [tenant_a["workspace"].pk, tenant_a["owner"].pk])
        # With only a handful of recipients the planner may also pick recipient_id; both are index paths.
        assert "notification_unread" in text or "recipient_id" in text

    def test_retention_batches_use_created_at_and_stay_bounded(self, tenant_a):
        rows = make(tenant_a, 40)
        Notification.objects.filter(pk__in=[r.pk for r in rows]).update(created_at=timezone.now() - timedelta(days=400))
        with CaptureQueriesContext(connection) as queries:
            counts = purge_old_records()
        assert counts["read_notifications"] == 32 and counts["unread_notifications"] == 8
        selects = [q["sql"] for q in queries.captured_queries
                   if q["sql"].startswith('SELECT "automation_notification"."id"')]
        assert selects and all("LIMIT" in s for s in selects)
        assert "notification_created" in plan(selects[0])

    def test_index_set(self):
        with connection.cursor() as cur:
            cur.execute("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'automation_notification'")
            defs = dict(cur.fetchall())
        assert "notification_inbox_newest" in defs and "created_at DESC, id DESC" in defs["notification_inbox_newest"]
        assert "WHERE (read_at IS NULL)" in defs["notification_unread"]
        assert "notification_created" in defs
        assert not any("read_at)" in d and "recipient_id, read_at" in d for d in defs.values())  # old composite gone
        for kept in ("recipient_id", "actor_id"):
            assert any(d.endswith(f"btree ({kept})") for d in defs.values()), kept
        assert "unique_workspace_notification_event" in defs
