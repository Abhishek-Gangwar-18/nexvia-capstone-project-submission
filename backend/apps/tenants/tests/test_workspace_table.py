"""Schema review, table #2 (tenants_workspace): slug/name CHECKs, single-query slug generation, and the
asynchronous, batched, resumable workspace deletion (apps/tenants/deletion.py)."""
import threading
import uuid
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
import stripe
from django.apps import apps
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, connection, connections, transaction
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.automation.models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport
from apps.automation.tasks import (
    create_daily_digests, delete_workspace, deliver_webhook, process_issue_event, resume_stalled_deletions,
)
from apps.billing import services as billing_services
from apps.billing.models import Subscription
from apps.issues.models import AuditLog, Issue, IssueAttachment, IssueComment, Label
from apps.projects.models import Project, Sprint, WorkflowTransition
from apps.projects.services import ARCHIVED_MESSAGE, create_project
from apps.tenants.deletion import LOCK_CLASS, purge_workspace, stalled_deletions, start_deletion
from apps.tenants.models import Invitation, Membership, Workspace, slugify_workspace

pytestmark = pytest.mark.django_db
BODY = {"password": "pass12345"}


def delete_request(api, tenant):
    return api(tenant["owner"], tenant["workspace"]).delete(
        "/api/workspace/", {**BODY, "confirm": tenant["workspace"].slug}, format="json")


def workspace_tables():
    """Every model with a workspace FK: the 18 cascading tables."""
    return [m for m in apps.get_models()
            if any(getattr(f, "related_model", None) is Workspace and f.name == "workspace" for f in m._meta.fields)]


def rows_left(workspace_id):
    left = {m._meta.db_table: m.objects.filter(workspace_id=workspace_id).count() for m in workspace_tables()}
    return {table: n for table, n in left.items() if n}


def populate(tenant, *, issues=6):
    """At least one row in every workspace table, with the awkward links: parent issues, redeliveries,
    transitions between statuses, label links, attachments with real files."""
    ws, owner = tenant["workspace"], tenant["owner"]
    project = tenant["project"]
    statuses = list(project.workflow.statuses.all())
    WorkflowTransition.objects.create(workflow=project.workflow, from_status=statuses[0], to_status=statuses[1])
    sprint = Sprint.objects.create(project=project, name="S1")
    label = Label.objects.create(workspace=ws, name="bug")
    parent = None
    for i in range(issues):
        issue = Issue.objects.create(project=project, title=f"i{i}", parent=parent if i % 3 else None, sprint=sprint)
        issue.labels.add(label)
        IssueComment.objects.create(issue=issue, author=owner, body=f"c{i}")
        parent = issue
    attachment = IssueAttachment.objects.create(
        workspace=ws, issue=parent, uploaded_by=owner, original_name="a.txt", content_type="text/plain", size=1,
        file=SimpleUploadedFile("a.txt", b"x"))
    AuditLog.objects.create(workspace=ws, action="updated", entity_type="issue", entity_label="x")
    Notification.objects.create(workspace=ws, recipient=owner, event_key="k", title="t", body="b")
    endpoint = WebhookEndpoint.objects.create(workspace=ws, name="hook", url="https://hooks.test/x", events=["*"])
    first = WebhookDelivery.objects.create(workspace=ws, endpoint=endpoint, event="issue.created", payload={}, event_id=uuid.uuid4())
    WebhookDelivery.objects.create(workspace=ws, endpoint=endpoint, event="issue.created", payload={}, event_id=uuid.uuid4(),
                                   redelivery_of=first, is_redelivery=True)
    WorkspaceReport.objects.create(workspace=ws, title="r", project=project, sprint=sprint)
    Subscription.objects.create(workspace=ws, stripe_customer_id=f"cus_{ws.pk}")
    Invitation.objects.create(workspace=ws, email="new@x.test", invited_by=owner)
    create_project(workspace=ws, name="Second", key="SEC", created_by=owner)
    return attachment


# ===================================================================== 1-2. CHECKs

class TestSlugAndNameChecks:
    @pytest.mark.parametrize("slug", ["Acme", "a--b", "-a", "a-", "a_b", "", "a b", "ä"])
    def test_db_rejects_malformed_slugs(self, tenant_a, slug):
        with pytest.raises(IntegrityError), transaction.atomic():
            Workspace.objects.filter(pk=tenant_a["workspace"].pk).update(slug=slug)

    def test_db_accepts_slugify_output(self, tenant_a):
        Workspace.objects.filter(pk=tenant_a["workspace"].pk).update(slug="acme-2-labs")

    @pytest.mark.parametrize("name", ["", "   "])
    def test_blank_name_rejected_by_api_and_db(self, api, tenant_a, name):
        res = api(tenant_a["owner"], tenant_a["workspace"]).patch("/api/workspace/", {"name": name}, format="json")
        assert res.status_code == 400
        with pytest.raises(IntegrityError), transaction.atomic():
            Workspace.objects.filter(pk=tenant_a["workspace"].pk).update(name=name)

    @pytest.mark.parametrize("name, slug", [("My Team", "my-team"), ("my_team", "my-team"), ("a _ b", "a-b"),
                                            ("Ünïcode Co", "unicode-co"), ("!!!", "workspace"), ("x" * 70, "x" * 50)])
    def test_generated_slugs_always_satisfy_the_check(self, name, slug):
        assert slugify_workspace(name) == slug


class TestSlugGeneration:
    def test_one_query_picks_the_next_free_suffix(self, tenant_a, make_user):
        owner = tenant_a["owner"]
        for slug in ("team", "team-2", "team-7", "team-x", "team-3-4", "teams"):
            Workspace.objects.create(name="Team", slug=slug, owner=owner)
        with CaptureQueriesContext(connection) as queries:
            slug = Workspace(name="Team", owner=owner)._unique_slug()
        assert slug == "team-8" and len(queries) == 1

    def test_base_used_when_free(self, tenant_a):
        Workspace.objects.create(name="x", slug="team-2", owner=tenant_a["owner"])
        assert Workspace(name="Team", owner=tenant_a["owner"])._unique_slug() == "team"

    def test_prefix_query_uses_the_slug_like_index(self, tenant_a):
        for i in range(30):
            Workspace.objects.create(name=f"Other {i}", owner=tenant_a["owner"])
        with CaptureQueriesContext(connection) as queries:
            Workspace(name="Team", owner=tenant_a["owner"])._unique_slug()
        sql = queries.captured_queries[0]["sql"]
        with connection.cursor() as cur:
            cur.execute("SET LOCAL enable_seqscan = off")
            cur.execute("EXPLAIN " + sql)  # no params: the captured SQL already has its values inlined
            plan = "\n".join(r[0] for r in cur.fetchall())
        assert "_like" in plan, plan  # the varchar_pattern_ops index serves LIKE 'team-%'

    def test_api_creates_distinct_slugs(self, api, make_user):
        user = make_user("slugs@x.test")
        client = api(user)
        slugs = [client.post("/api/workspaces/", {"name": "Same Name"}, format="json").data["slug"] for _ in range(3)]
        assert slugs == ["same-name", "same-name-2", "same-name-3"]


# ============================================================ 4. async deletion

class TestDeleteRequest:
    def test_returns_202_and_hides_the_workspace_at_once(self, api, tenant_a):
        ws = tenant_a["workspace"]
        Issue.objects.create(project=tenant_a["project"], title="still here until the purge")
        res = delete_request(api, tenant_a)  # on_commit doesn't fire in this test: the purge hasn't run
        assert res.status_code == 202
        ws.refresh_from_db()
        assert ws.deleting_at is not None
        client = api(tenant_a["owner"], ws)
        assert client.get("/api/workspace/").status_code == 404
        assert client.get("/api/issues/?page=1").status_code == 404
        assert client.post("/api/issues/", {"project": tenant_a["project"].pk, "title": "x"},
                           format="json").status_code == 404
        assert ws.slug not in [w["slug"] for w in api(tenant_a["owner"]).get("/api/workspaces/").data]
        assert delete_request(api, tenant_a).status_code == 404  # a second delete: already gone

    def test_invitations_to_a_deleting_workspace_stop_working(self, api, tenant_a):
        invitation = Invitation(workspace=tenant_a["workspace"], email="late@x.test", invited_by=tenant_a["owner"])
        raw = invitation.issue_token()
        invitation.save()
        assert api().get(f"/api/invitations/preview/{raw}/").status_code == 200
        delete_request(api, tenant_a)
        assert api().get(f"/api/invitations/preview/{raw}/").status_code != 200

    def test_deleting_workspace_does_not_count_toward_the_owner_cap(self, api, make_user, settings):
        settings.MAX_OWNED_WORKSPACES = 1
        user = make_user("cap@x.test")
        client = api(user)
        first = client.post("/api/workspaces/", {"name": "First"}, format="json").data
        ws = Workspace.objects.get(pk=first["id"])
        api(user, ws).delete("/api/workspace/", {**BODY, "confirm": ws.slug}, format="json")
        assert client.post("/api/workspaces/", {"name": "Second"}, format="json").status_code == 201

    def test_request_never_calls_stripe(self, api, tenant_a, monkeypatch):
        """Cancelling before the mark commits could leave a live workspace without a subscription if the
        process died in between. The request only marks; the durable purge cancels."""
        fake = MagicMock()
        monkeypatch.setattr(billing_services, "client", lambda: fake)
        Subscription.objects.create(workspace=tenant_a["workspace"], stripe_customer_id="cus_1",
                                    stripe_subscription_id="sub_1", status="active")
        assert delete_request(api, tenant_a).status_code == 202
        fake.v1.subscriptions.cancel.assert_not_called()
        tenant_a["workspace"].refresh_from_db()
        assert tenant_a["workspace"].deleting_at is not None
        assert Subscription.objects.get(workspace=tenant_a["workspace"]).status == "active"

    def test_crash_after_the_mark_is_recovered_and_cancels(self, api, tenant_a, monkeypatch,
                                                           django_capture_on_commit_callbacks):
        """The process dies right after the mark commits, so the purge is never queued: the sweep finds it,
        cancels Stripe, then deletes. Stripe is never cancelled for a workspace that stays live."""
        fake = MagicMock()
        monkeypatch.setattr(billing_services, "client", lambda: fake)
        ws = tenant_a["workspace"]
        Subscription.objects.create(workspace=ws, stripe_customer_id="cus_1", stripe_subscription_id="sub_1",
                                    status="active")
        with patch("apps.automation.tasks.delete_workspace.delay", side_effect=SystemExit("worker killed")), \
                pytest.raises(SystemExit), django_capture_on_commit_callbacks(execute=True):
            delete_request(api, tenant_a)
        fake.v1.subscriptions.cancel.assert_not_called()
        Workspace.objects.filter(pk=ws.pk).update(deleting_at=timezone.now() - timedelta(minutes=11))
        resume_stalled_deletions()
        fake.v1.subscriptions.cancel.assert_called_once()
        assert not Workspace.objects.filter(pk=ws.pk).exists()

    def test_lost_enqueue_is_recovered_by_the_sweep(self, api, tenant_a, django_capture_on_commit_callbacks):
        with patch("apps.automation.tasks.delete_workspace.delay", side_effect=ConnectionError("broker down")), \
                django_capture_on_commit_callbacks(execute=True):
            assert delete_request(api, tenant_a).status_code == 202  # still accepted: marked, not queued
        ws = tenant_a["workspace"]
        assert Workspace.objects.filter(pk=ws.pk).exists()
        assert ws.pk not in stalled_deletions()  # too recent to count as stalled
        Workspace.objects.filter(pk=ws.pk).update(deleting_at=timezone.now() - timedelta(minutes=11))
        assert ws.pk in resume_stalled_deletions()  # re-queued; eager in tests, so it runs now
        assert not Workspace.objects.filter(pk=ws.pk).exists()


class TestPurge:
    def test_removes_every_table_and_leaves_other_tenants_alone(self, tenant_a, tenant_b):
        populate(tenant_a)
        populate(tenant_b)
        assert len(rows_left(tenant_a["workspace"].pk)) == 18  # really one row in every workspace table
        before_b = rows_left(tenant_b["workspace"].pk)
        Workspace.objects.filter(pk=tenant_a["workspace"].pk).update(deleting_at=timezone.now())
        assert purge_workspace(tenant_a["workspace"].pk, batch_size=2) == "deleted"
        assert rows_left(tenant_a["workspace"].pk) == {}
        assert not Workspace.objects.filter(pk=tenant_a["workspace"].pk).exists()
        assert rows_left(tenant_b["workspace"].pk) == before_b

    def test_batches_are_bounded(self, tenant_a):
        populate(tenant_a, issues=9)
        Workspace.objects.filter(pk=tenant_a["workspace"].pk).update(deleting_at=timezone.now())
        with CaptureQueriesContext(connection) as queries:
            purge_workspace(tenant_a["workspace"].pk, batch_size=4)
        selects = [q["sql"] for q in queries.captured_queries
                   if q["sql"].startswith('SELECT "issues_issue"."id" AS "pk" FROM "issues_issue" WHERE "issues_issue"."workspace_id" =')]
        assert len(selects) == 4  # 9 issues in batches of 4: 4 + 4 + 1, then one empty check
        assert all(s.endswith("LIMIT 4") and "ORDER BY" not in s for s in selects)

    def test_never_touches_a_live_workspace(self, tenant_a):
        assert purge_workspace(tenant_a["workspace"].pk) == "gone"
        assert Workspace.objects.filter(pk=tenant_a["workspace"].pk).exists()

    def test_rows_committed_before_the_mark_are_removed(self, tenant_a):
        Issue.objects.create(project=tenant_a["project"], title="finished just before deletion began")
        Workspace.objects.filter(pk=tenant_a["workspace"].pk).update(deleting_at=timezone.now())
        assert purge_workspace(tenant_a["workspace"].pk) == "deleted"
        assert rows_left(tenant_a["workspace"].pk) == {}

    def test_webhooks_and_digests_skip_a_deleting_workspace(self, tenant_a, monkeypatch):
        monkeypatch.setattr("apps.automation.tasks.enqueue", MagicMock(return_value=None))
        ws = tenant_a["workspace"]
        endpoint = WebhookEndpoint.objects.create(workspace=ws, name="h", url="https://hooks.test/x", events=["*"])
        pending = WebhookDelivery.objects.create(workspace=ws, endpoint=endpoint, event="issue.created", payload={}, event_id=uuid.uuid4())
        audit = AuditLog.objects.create(workspace=ws, action="created", entity_type="issue", entity_label="x",
                                        actor=tenant_a["owner"])
        Workspace.objects.filter(pk=ws.pk).update(deleting_at=timezone.now())
        process_issue_event(audit.pk)
        assert WebhookDelivery.objects.filter(workspace=ws).count() == 1  # no new delivery
        with patch("apps.automation.tasks._send") as send:
            deliver_webhook(pending.pk)
        send.assert_not_called()
        pending.refresh_from_db()
        assert pending.state == WebhookDelivery.State.FAILED
        assert ws.pk not in create_daily_digests()


class TestStripeRetry:
    def test_task_retries_until_stripe_confirms_and_touches_nothing_before(self, tenant_a, monkeypatch):
        ws = tenant_a["workspace"]
        Issue.objects.create(project=tenant_a["project"], title="kept until cancelled")
        Subscription.objects.create(workspace=ws, stripe_customer_id="cus_1", stripe_subscription_id="sub_1",
                                    status="active")
        fake = MagicMock()
        down = stripe.APIConnectionError("down")
        seen = []

        def cancel(*args, **kwargs):
            seen.append(Issue.objects.filter(workspace=ws).count())  # data untouched while Stripe fails
            if len(seen) < 3:
                raise down

        fake.v1.subscriptions.cancel.side_effect = cancel
        monkeypatch.setattr(billing_services, "client", lambda: fake)
        Workspace.objects.filter(pk=ws.pk).update(deleting_at=timezone.now())
        result = delete_workspace.apply(args=[ws.pk])  # eager: retries run inline (countdown ignored)
        assert result.successful() and result.get() == "deleted"
        assert seen == [1, 1, 1] and fake.v1.subscriptions.cancel.call_count == 3
        assert not Workspace.objects.filter(pk=ws.pk).exists()

    def test_exhausted_retries_leave_it_hidden_for_the_sweep(self, tenant_a, monkeypatch):
        ws = tenant_a["workspace"]
        Subscription.objects.create(workspace=ws, stripe_customer_id="cus_1", stripe_subscription_id="sub_1",
                                    status="active")
        fake = MagicMock()
        fake.v1.subscriptions.cancel.side_effect = stripe.APIConnectionError("down")
        monkeypatch.setattr(billing_services, "client", lambda: fake)
        Workspace.objects.filter(pk=ws.pk).update(deleting_at=timezone.now() - timedelta(hours=1))
        assert delete_workspace.apply(args=[ws.pk]).failed()
        assert Workspace.objects.filter(pk=ws.pk, deleting_at__isnull=False).exists()
        assert ws.pk in stalled_deletions()


# -------------------------------------------- real commits: retries, files, concurrency

@pytest.mark.django_db(transaction=True)
class TestCommitted:
    def test_partial_purge_then_retry_completes(self, tenant_a, settings, tmp_path):
        settings.MEDIA_ROOT = tmp_path
        populate(tenant_a, issues=8)
        ws_id = tenant_a["workspace"].pk
        Workspace.objects.filter(pk=ws_id).update(deleting_at=timezone.now())
        real_delete = Issue.objects.filter(pk=0).delete.__func__
        calls = {"n": 0}

        def flaky(qs):
            if qs.model is Issue:
                calls["n"] += 1
                if calls["n"] == 3:
                    raise RuntimeError("worker crashed mid-purge")
            return real_delete(qs)

        with patch("django.db.models.query.QuerySet.delete", flaky), pytest.raises(RuntimeError):
            purge_workspace(ws_id, batch_size=2)
        left = rows_left(ws_id)
        assert "issues_issuecomment" not in left and "issues_auditlog" not in left  # earlier steps committed
        assert 0 < Issue.objects.filter(workspace_id=ws_id).count() < 8  # two issue batches committed
        assert Workspace.objects.filter(pk=ws_id).exists()
        assert purge_workspace(ws_id, batch_size=2) == "deleted"  # resume
        assert rows_left(ws_id) == {} and not Workspace.objects.filter(pk=ws_id).exists()

    def test_attachment_files_removed_after_each_batch_commits(self, tenant_a, settings, tmp_path):
        settings.MEDIA_ROOT = tmp_path
        attachment = populate(tenant_a)
        storage, name = attachment.file.storage, attachment.file.name
        assert storage.exists(name)
        Workspace.objects.filter(pk=tenant_a["workspace"].pk).update(deleting_at=timezone.now())
        purge_workspace(tenant_a["workspace"].pk)
        assert not storage.exists(name)

    def test_a_second_purge_waits_its_turn(self, tenant_a):
        ws_id = tenant_a["workspace"].pk
        Workspace.objects.filter(pk=ws_id).update(deleting_at=timezone.now())
        holding, release = threading.Event(), threading.Event()

        def other_worker():
            conn = connections.create_connection("default")
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT pg_advisory_lock(%s, %s)", [LOCK_CLASS, ws_id])
                    holding.set()
                    release.wait(10)
                    cur.execute("SELECT pg_advisory_unlock(%s, %s)", [LOCK_CLASS, ws_id])
            finally:
                conn.close()

        thread = threading.Thread(target=other_worker)
        thread.start()
        holding.wait(10)
        try:
            assert purge_workspace(ws_id) == "busy"
            assert Workspace.objects.filter(pk=ws_id).exists()
        finally:
            release.set()
            thread.join()
        assert purge_workspace(ws_id) == "deleted"

    def test_concurrent_writes_during_deletion(self, api, tenant_a):
        """Requests racing the delete: each either finishes before the mark or gets a 404 after it; whatever
        they managed to write is removed by the purge. Nothing survives and nothing errors with a 500."""
        from rest_framework.test import APIClient

        ws = tenant_a["workspace"]
        codes, barrier = [], threading.Barrier(5)

        def writer(i):
            c = APIClient()
            c.force_authenticate(tenant_a["owner"])
            c.credentials(HTTP_X_WORKSPACE=ws.slug)
            barrier.wait()
            for n in range(4):
                codes.append(c.post("/api/issues/", {"project": tenant_a["project"].pk, "title": f"{i}-{n}"},
                                    format="json").status_code)
            connection.close()

        def deleter():
            c = APIClient()
            c.force_authenticate(tenant_a["owner"])
            c.credentials(HTTP_X_WORKSPACE=ws.slug)
            barrier.wait()
            codes.append(("delete", c.delete("/api/workspace/", {**BODY, "confirm": ws.slug},
                                               format="json").status_code))
            connection.close()

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(4)] + [threading.Thread(target=deleter)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert ("delete", 202) in codes
        assert {c for c in codes if not isinstance(c, tuple)} <= {201, 404}
        # The purge ran eagerly after the delete committed; any writer that slipped in is gone with it.
        if Workspace.objects.filter(pk=ws.pk).exists():  # a writer committed after the purge started
            assert purge_workspace(ws.pk) in ("deleted", "gone")
        assert rows_left(ws.pk) == {} and not Workspace.objects.filter(pk=ws.pk).exists()


# --------------------------------------------- migration: report, never rewrite slugs

@pytest.mark.django_db(transaction=True)
def test_migration_reports_bad_slugs_instead_of_rewriting(tenant_a):
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    ws_id = tenant_a["workspace"].pk
    try:
        MigrationExecutor(connection).migrate([("tenants", "0008_invitation_hashed_token_lowercase_email")])
        with connection.cursor() as cur:
            cur.execute("UPDATE tenants_workspace SET slug = 'Bad_Slug' WHERE id = %s", [ws_id])
        with pytest.raises(RuntimeError, match="Bad_Slug"):
            latest()
        with connection.cursor() as cur:
            cur.execute("SELECT slug FROM tenants_workspace WHERE id = %s", [ws_id])
            assert cur.fetchone()[0] == "Bad_Slug"  # left exactly as it was
    finally:
        with connection.cursor() as cur:
            cur.execute("UPDATE tenants_workspace SET slug = 'acme' WHERE id = %s", [ws_id])
        latest()


# ------------------------------------- in-flight writes are rejected once deletion began

def _is_deleting_error(exc):
    from apps.core.exceptions import WORKSPACE_DELETING_SQLSTATE

    return getattr(exc.__cause__, "sqlstate", None) == WORKSPACE_DELETING_SQLSTATE


class TestInsertsRejectedOnceDeleting:
    def test_every_workspace_table_has_the_trigger(self):
        with connection.cursor() as cur:
            cur.execute("SELECT event_object_table FROM information_schema.triggers "
                        "WHERE trigger_name = 'trg_reject_insert_into_deleting_workspace'")
            guarded = {r[0] for r in cur.fetchall()}
        assert {m._meta.db_table for m in workspace_tables()} <= guarded

    def test_orm_and_bulk_inserts_fail(self, tenant_a):
        ws = tenant_a["workspace"]
        Workspace.objects.filter(pk=ws.pk).update(deleting_at=timezone.now())
        writes = [
            lambda: Issue.objects.create(project=tenant_a["project"], title="late"),
            lambda: Label.objects.bulk_create([Label(workspace=ws, name="late")]),
            lambda: Notification.objects.create(workspace=ws, recipient=tenant_a["owner"], event_key="k",
                                                title="t", body="b"),
        ]
        for write in writes:
            with pytest.raises(Exception) as caught, transaction.atomic():
                write()
            assert _is_deleting_error(caught.value)
        assert Issue.objects.filter(workspace=ws).count() == 0

    def test_live_workspaces_are_unaffected(self, tenant_a):
        assert Issue.objects.create(project=tenant_a["project"], title="fine").pk

    def test_request_resolved_before_the_mark_gets_a_404_not_a_201(self, api, tenant_a):
        """The workspace was resolved, then deletion began, then the request tried to insert."""
        from apps.core.api import WorkspaceScopedMixin

        real = WorkspaceScopedMixin.resolve_workspace

        def resolve_then_delete(view, request):
            real(view, request)
            Workspace.objects.filter(pk=tenant_a["workspace"].pk).update(deleting_at=timezone.now())

        with patch.object(WorkspaceScopedMixin, "resolve_workspace", resolve_then_delete):
            res = api(tenant_a["owner"], tenant_a["workspace"]).post(
                "/api/issues/", {"project": tenant_a["project"].pk, "title": "too late"}, format="json")
        assert res.status_code == 404
        assert Issue.objects.filter(workspace=tenant_a["workspace"]).count() == 0


@pytest.mark.django_db(transaction=True)
class TestInsertVsMarkOrdering:
    """The two possible interleavings, with real transactions on two connections."""

    def _in_thread(self, fn):
        out = {}

        def run():
            try:
                out["result"] = fn()
            except Exception as exc:  # reported to the test
                out["error"] = exc
            finally:
                connection.close()

        thread = threading.Thread(target=run)
        thread.start()
        return thread, out

    def test_insert_first_then_mark_waits_and_the_insert_counts_as_before(self, tenant_a):
        ws = tenant_a["workspace"]
        with transaction.atomic():
            Issue.objects.create(project=tenant_a["project"], title="in progress")  # holds FOR KEY SHARE
            with patch("apps.automation.queue.enqueue"):  # mark only; the purge is run explicitly below
                thread, out = self._in_thread(lambda: start_deletion(Workspace.objects.get(pk=ws.pk)))
                thread.join(1.5)
                assert thread.is_alive()  # the mark is waiting for this insert's transaction
        thread.join(10)
        assert out.get("result") is True and "error" not in out
        assert Issue.objects.filter(workspace=ws, title="in progress").exists()  # committed before deletion
        assert purge_workspace(ws.pk) == "deleted" and rows_left(ws.pk) == {}

    def test_mark_first_then_insert_waits_and_is_rejected(self, tenant_a):
        ws = tenant_a["workspace"]
        with transaction.atomic():
            # Exactly what start_deletion does: FOR UPDATE (a plain UPDATE only takes FOR NO KEY UPDATE, which
            # doesn't conflict with FOR KEY SHARE), then the mark.
            locked = Workspace.objects.select_for_update().get(pk=ws.pk)
            locked.deleting_at = timezone.now()
            locked.save(update_fields=["deleting_at"])
            thread, out = self._in_thread(
                lambda: Issue.objects.create(project=Project.objects.get(pk=tenant_a["project"].pk), title="late"))
            thread.join(1.5)
            assert thread.is_alive()  # the insert is waiting for the mark
        thread.join(10)
        assert "error" in out and _is_deleting_error(out["error"])
        assert not Issue.objects.filter(workspace=ws, title="late").exists()
        assert purge_workspace(ws.pk) == "deleted"


# ------------------------------------------------------ workspace_id is immutable

class TestWorkspaceIdImmutable:
    def test_every_workspace_table_has_the_trigger(self):
        with connection.cursor() as cur:
            cur.execute("SELECT DISTINCT event_object_table FROM information_schema.triggers "
                        "WHERE trigger_name = 'trg_workspace_id_immutable'")
            guarded = {r[0] for r in cur.fetchall()}
        assert {m._meta.db_table for m in workspace_tables()} <= guarded

    def test_rows_cannot_move_to_another_or_a_deleting_workspace(self, tenant_a, tenant_b):
        from apps.core.exceptions import WORKSPACE_ID_IMMUTABLE_SQLSTATE

        issue = Issue.objects.create(project=tenant_a["project"], title="stays")
        label = Label.objects.create(workspace=tenant_a["workspace"], name="stays")
        Workspace.objects.filter(pk=tenant_b["workspace"].pk).update(deleting_at=timezone.now())
        for qs in (Issue.objects.filter(pk=issue.pk), Label.objects.filter(pk=label.pk),
                   Membership.objects.filter(workspace=tenant_a["workspace"], user=tenant_a["owner"])):
            with pytest.raises(Exception) as caught, transaction.atomic():
                qs.update(workspace_id=tenant_b["workspace"].pk)
            assert getattr(caught.value.__cause__, "sqlstate", None) == WORKSPACE_ID_IMMUTABLE_SQLSTATE
        assert Issue.objects.get(pk=issue.pk).workspace_id == tenant_a["workspace"].pk

    def test_normal_saves_still_work(self, tenant_a):
        issue = Issue.objects.create(project=tenant_a["project"], title="a")
        issue.title = "b"
        issue.save()  # full-row save rewrites workspace_id with the same value: allowed
        Issue.objects.filter(pk=issue.pk).update(workspace_id=tenant_a["workspace"].pk)


# ---------------------------------- deadlock check: restores vs inserts, concurrently

@pytest.mark.django_db(transaction=True)
def test_project_restore_and_issue_creation_run_concurrently(tenant_a):
    """Restore locks the workspace (now FOR NO KEY UPDATE) then the project; issue creation locks the project
    then takes FOR KEY SHARE on the workspace (trigger + FK). Hammer both, plus project creation and archiving,
    from several threads: every request must finish (no deadlock) with an expected status (no 500/409)."""
    from rest_framework.test import APIClient

    ws = tenant_a["workspace"]
    Workspace.objects.filter(pk=ws.pk).update(plan=Workspace.Plan.ENTERPRISE)
    flip = tenant_a["project"]
    steady = create_project(workspace=ws, name="Steady", key="STD", created_by=tenant_a["owner"])
    results, barrier = [], threading.Barrier(6)

    def client():
        c = APIClient()
        c.force_authenticate(tenant_a["owner"])
        c.credentials(HTTP_X_WORKSPACE=ws.slug)
        return c

    def run(name, calls):
        try:
            c = client()
            barrier.wait()
            for _ in range(6):
                for call in calls:
                    res = call(c)
                    # Two flippers race: archiving an already-archived project is refused (read-only rule).
                    code = "archived" if res.status_code == 400 and ARCHIVED_MESSAGE in str(res.data) else res.status_code
                    results.append((name, code))
        except Exception as exc:  # deadlocks would surface here or as 500s
            results.append((name, repr(exc)))
        finally:
            connection.close()

    flipper = [lambda c: c.patch(f"/api/projects/{flip.key}/", {"is_archived": True}, format="json"),
               lambda c: c.patch(f"/api/projects/{flip.key}/", {"is_archived": False}, format="json")]  # restore
    into_flip = [lambda c: c.post("/api/issues/", {"project": flip.pk, "title": "f"}, format="json")]
    into_steady = [lambda c: c.post("/api/issues/", {"project": steady.pk, "title": "s"}, format="json")]
    counter = iter(range(1000))
    new_project = [lambda c: c.post("/api/projects/", {"name": "N", "key": f"NP{next(counter)}"}, format="json")]
    threads = [threading.Thread(target=run, args=args) for args in [
        ("flipper", flipper), ("flipper2", flipper), ("into_flip", into_flip), ("into_steady", into_steady),
        ("into_steady2", into_steady), ("new_project", new_project)]]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert not any(t.is_alive() for t in threads), "a request never finished (deadlock?)"
    allowed = {"flipper": {200, "archived"}, "flipper2": {200, "archived"}, "into_flip": {201, "archived"}, "into_steady": {201},
               "into_steady2": {201}, "new_project": {201}}
    unexpected = [(n, code) for n, code in results if code not in allowed[n]]
    assert not unexpected, unexpected
    numbers = list(Issue.objects.filter(project=steady).values_list("number", flat=True))
    assert len(numbers) == 12 and len(set(numbers)) == 12
