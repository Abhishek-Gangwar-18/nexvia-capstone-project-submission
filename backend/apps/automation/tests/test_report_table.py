"""Schema review, table #18 (automation_workspacereport): pending reports that lost their source leave the
dedup rule (no more blocked project/sprint deletes), lost builds are failed nightly (bounded, conditional),
and error is set exactly when a report failed."""
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.automation import tasks
from apps.automation.models import WorkspaceReport
from apps.automation.tasks import REPORT_FAILED_MESSAGE, fail_stale_reports, generate_workspace_report, purge_old_records
from apps.projects.models import Sprint
from apps.projects.services import create_project

pytestmark = pytest.mark.django_db


def report(tenant, report_type="workspace_summary", **extra):
    return WorkspaceReport.objects.create(workspace=tenant["workspace"], report_type=report_type, **extra)


def owner(api, tenant):
    return api(tenant["owner"], tenant["workspace"])


# ========================================== 1. source deletion vs pending dedup

class TestSourceDeletion:
    def test_delete_project_with_two_pending_burndowns(self, api, tenant_a):
        project = tenant_a["project"]
        sprints = [Sprint.objects.create(project=project, name=n) for n in ("A", "B")]
        rows = [report(tenant_a, "sprint_burndown", project=project, sprint=s) for s in sprints]
        res = owner(api, tenant_a).delete(f"/api/projects/{project.key}/", {"confirm": project.key}, format="json")
        assert res.status_code == 204  # was 409
        kept = WorkspaceReport.objects.filter(pk__in=[r.pk for r in rows])
        assert kept.count() == 2 and all(r.project_id is None and r.sprint_id is None for r in kept)  # history kept

    def test_delete_sprint_when_another_pending_burndown_already_lost_its_sprint(self, api, tenant_a):
        project = tenant_a["project"]
        orphan = report(tenant_a, "sprint_burndown", project=project, sprint=None)  # its sprint is already gone
        sprint = Sprint.objects.create(project=project, name="Doomed")
        live = report(tenant_a, "sprint_burndown", project=project, sprint=sprint)
        assert owner(api, tenant_a).delete(f"/api/sprints/{sprint.pk}/").status_code == 204
        live.refresh_from_db()
        assert live.sprint_id is None and WorkspaceReport.objects.filter(pk=orphan.pk).exists()

    def test_velocity_reports_of_deleted_projects_coexist(self, api, tenant_a):
        other = create_project(workspace=tenant_a["workspace"], name="Two", key="TWO", created_by=tenant_a["owner"])
        for p in (tenant_a["project"], other):
            report(tenant_a, "velocity", project=p)
        for key in (tenant_a["project"].key, "TWO"):
            assert owner(api, tenant_a).delete(f"/api/projects/{key}/", {"confirm": key},
                                               format="json").status_code == 204
        assert WorkspaceReport.objects.filter(report_type="velocity", project__isnull=True).count() == 2

    def test_dedup_still_applies_while_the_source_exists(self, tenant_a):
        sprint = Sprint.objects.create(project=tenant_a["project"], name="S")
        report(tenant_a, "sprint_burndown", project=tenant_a["project"], sprint=sprint)
        for duplicate in (
            lambda: report(tenant_a, "sprint_burndown", project=tenant_a["project"], sprint=sprint),
            lambda: report(tenant_a, "velocity", project=tenant_a["project"]) and report(
                tenant_a, "velocity", project=tenant_a["project"]),
        ):
            with pytest.raises(IntegrityError), transaction.atomic():
                duplicate()
        report(tenant_a)  # one pending summary...
        with pytest.raises(IntegrityError), transaction.atomic():
            report(tenant_a)  # ...summaries (no source) always dedupe, NULLs counting as equal

    def test_api_still_reuses_an_identical_pending_request(self, api, tenant_a, monkeypatch):
        monkeypatch.setattr("apps.automation.views.enqueue", lambda *a: None)
        client = owner(api, tenant_a)
        first = client.post("/api/reports/", {"report_type": "workspace_summary"}, format="json")
        second = client.post("/api/reports/", {"report_type": "workspace_summary"}, format="json")
        assert (first.status_code, second.status_code) == (202, 200) and first.data["id"] == second.data["id"]


# ============================================================ 2. stale pending

class TestStaleReports:
    def age(self, row, minutes):
        WorkspaceReport.objects.filter(pk=row.pk).update(created_at=timezone.now() - timedelta(minutes=minutes))

    def test_nightly_run_fails_lost_builds_only(self, tenant_a):
        lost, recent, done = report(tenant_a), report(tenant_a, "velocity", project=tenant_a["project"]), \
            report(tenant_a, "velocity", project=None, state="ready")
        self.age(lost, 20)
        self.age(done, 20)
        counts = purge_old_records()
        assert counts["stale_reports_failed"] == 1
        lost.refresh_from_db(); recent.refresh_from_db(); done.refresh_from_db()
        assert (lost.state, lost.error) == ("failed", REPORT_FAILED_MESSAGE)
        assert recent.state == "pending" and done.state == "ready"

    def test_batches_are_bounded(self, tenant_a, monkeypatch):
        monkeypatch.setattr(tasks, "PURGE_BATCH", 2)
        sprints = [Sprint.objects.create(project=tenant_a["project"], name=f"S{i}") for i in range(5)]
        rows = [report(tenant_a, "sprint_burndown", project=tenant_a["project"], sprint=s) for s in sprints]
        for r in rows:
            self.age(r, 30)
        assert fail_stale_reports() == 5
        assert not WorkspaceReport.objects.filter(state="pending").exists()

    def test_late_worker_cannot_overwrite_the_sweep(self, tenant_a):
        row = report(tenant_a)
        self.age(row, 20)
        real = tasks.BUILDERS["workspace_summary"]

        def slow_build(r):
            fail_stale_reports()  # the sweep marks it failed while the build is still running
            return real(r)

        with patch.dict(tasks.BUILDERS, {"workspace_summary": slow_build}):
            generate_workspace_report(row.pk)
        row.refresh_from_db()
        assert (row.state, row.error) == ("failed", REPORT_FAILED_MESSAGE) and row.data == {}

    def test_sweep_cannot_overwrite_a_finished_build(self, tenant_a):
        row = report(tenant_a)
        self.age(row, 20)
        generate_workspace_report(row.pk)  # finishes first
        assert fail_stale_reports() == 0
        row.refresh_from_db()
        assert row.state == "ready" and row.error == ""

    def test_stale_failed_reports_then_age_out(self, tenant_a, settings):
        row = report(tenant_a)
        WorkspaceReport.objects.filter(pk=row.pk).update(created_at=timezone.now() - timedelta(days=400))
        purge_old_records()
        assert not WorkspaceReport.objects.filter(pk=row.pk).exists()  # failed then purged in the same run


# ================================================================ 3. error CHECK

@pytest.mark.parametrize("state, error", [("failed", ""), ("pending", "oops"), ("ready", "oops")])
def test_error_iff_failed(tenant_a, state, error):
    row = report(tenant_a)
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkspaceReport.objects.filter(pk=row.pk).update(state=state, error=error)


def test_valid_combinations(tenant_a):
    row = report(tenant_a)
    WorkspaceReport.objects.filter(pk=row.pk).update(state="ready", error="")
    WorkspaceReport.objects.filter(pk=row.pk).update(state="failed", error="x")


def test_index_predicate():
    with connection.cursor() as cur:
        cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'one_pending_identical_report'")
        definition = cur.fetchone()[0]
    assert "NULLS NOT DISTINCT" in definition and "project_id IS NOT NULL" in definition
    assert "sprint_id IS NOT NULL" in definition and "workspace_summary" in definition


# ------------------------------------------------ migration: report, no fixes

@pytest.mark.django_db(transaction=True)
def test_migration_reports_bad_error_state(tenant_a):
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    row = report(tenant_a)
    try:
        MigrationExecutor(connection).migrate([("automation", "0007_notification_inbox_indexes")])
        with connection.cursor() as cur:
            cur.execute("UPDATE automation_workspacereport SET state = 'failed', error = '' WHERE id = %s", [row.pk])
        with pytest.raises(RuntimeError, match=str(row.pk)):
            latest()
    finally:
        with connection.cursor() as cur:
            cur.execute("UPDATE automation_workspacereport SET state = 'pending', error = '' WHERE id = %s", [row.pk])
        latest()
