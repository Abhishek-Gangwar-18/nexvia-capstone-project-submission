"""Schema review, table #12 (projects_sprint): a PATCH never undoes start/complete (lock, re-read, re-validate,
changed columns only), goal/name limits, completed_at <-> closed, and totals via subqueries only where shown."""
import threading
from datetime import date, timedelta
from unittest.mock import patch

import pytest
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.issues.models import Issue
from apps.projects.models import SPRINT_GOAL_MAX, Sprint, WorkflowStatus
from apps.projects.services import lock_project
from apps.projects.views import SprintViewSet

pytestmark = pytest.mark.django_db


def owner(api, tenant):
    return api(tenant["owner"], tenant["workspace"])


def planned(tenant, **extra):
    return Sprint.objects.create(project=tenant["project"], name="S1", **extra)


def meanwhile(action_name, fn):
    """Patch get_object so `fn(sprint)` runs between the PATCH loading the sprint and saving it."""
    real = SprintViewSet.get_object

    def stale(view):
        obj = real(view)
        if view.action == action_name:
            fn(obj)
        return obj

    return patch.object(SprintViewSet, "get_object", stale)


# ======================================================= 1. stale PATCH races

class TestPatchRaces:
    def test_patch_name_vs_start(self, api, tenant_a):
        sprint = planned(tenant_a)
        start = lambda s: owner(api, tenant_a).post(f"/api/sprints/{s.pk}/start/", {}, format="json")
        with meanwhile("partial_update", start):
            res = owner(api, tenant_a).patch(f"/api/sprints/{sprint.pk}/", {"name": "Renamed"}, format="json")
        assert res.status_code == 200
        sprint.refresh_from_db()
        assert (sprint.state, sprint.name) == (Sprint.State.ACTIVE, "Renamed")
        assert sprint.start_date and sprint.end_date  # the start's dates survived
        assert res.data["state"] == "active"

    def test_patch_name_vs_complete_is_refused(self, api, tenant_a):
        sprint = planned(tenant_a, state=Sprint.State.ACTIVE, start_date=date(2026, 11, 1), end_date=date(2026, 11, 14))
        complete = lambda s: owner(api, tenant_a).post(f"/api/sprints/{s.pk}/complete/", {}, format="json")
        with meanwhile("partial_update", complete):
            res = owner(api, tenant_a).patch(f"/api/sprints/{sprint.pk}/", {"name": "Late"}, format="json")
        assert res.status_code == 400 and "read-only" in str(res.data)
        sprint.refresh_from_db()
        assert sprint.state == Sprint.State.CLOSED and sprint.completed_at and sprint.name == "S1"

    def test_patch_date_vs_start(self, api, tenant_a):
        sprint = planned(tenant_a)
        start = lambda s: owner(api, tenant_a).post(f"/api/sprints/{s.pk}/start/", {"start_date": "2026-11-10"},
                                                     format="json")
        with meanwhile("partial_update", start):
            res = owner(api, tenant_a).patch(f"/api/sprints/{sprint.pk}/", {"end_date": "2026-11-30"}, format="json")
        assert res.status_code == 200
        sprint.refresh_from_db()
        assert sprint.state == Sprint.State.ACTIVE
        assert (sprint.start_date, sprint.end_date) == (date(2026, 11, 10), date(2026, 11, 30))

    def test_patch_date_validated_against_the_started_dates(self, api, tenant_a):
        """Valid against the stale (undated) sprint, invalid against the started one: refused."""
        sprint = planned(tenant_a)
        start = lambda s: owner(api, tenant_a).post(f"/api/sprints/{s.pk}/start/", {"start_date": "2026-11-10"},
                                                     format="json")
        with meanwhile("partial_update", start):
            res = owner(api, tenant_a).patch(f"/api/sprints/{sprint.pk}/", {"end_date": "2026-11-01"}, format="json")
        assert res.status_code == 400 and "end_date" in res.data

    def test_patch_sql_never_writes_state_or_completed_at(self, api, tenant_a):
        sprint = planned(tenant_a)
        with CaptureQueriesContext(connection) as queries:
            assert owner(api, tenant_a).patch(f"/api/sprints/{sprint.pk}/", {"goal": "g"}, format="json").status_code == 200
        updates = [q["sql"] for q in queries.captured_queries if q["sql"].startswith('UPDATE "projects_sprint"')]
        assert updates and not any('"state"' in s or '"completed_at"' in s or '"start_date"' in s for s in updates)

    def test_active_sprint_dates_cannot_be_cleared(self, api, tenant_a):
        sprint = planned(tenant_a, state=Sprint.State.ACTIVE, start_date=date(2026, 11, 1), end_date=date(2026, 11, 14))
        res = owner(api, tenant_a).patch(f"/api/sprints/{sprint.pk}/", {"end_date": None}, format="json")
        assert res.status_code == 400


@pytest.mark.django_db(transaction=True)
def test_patch_waiting_behind_a_complete_sees_the_closed_sprint(tenant_a):
    """The PATCH starts while a complete holds the project lock, and gets the lock only after it commits."""
    from rest_framework.test import APIClient

    sprint = planned(tenant_a, state=Sprint.State.ACTIVE, start_date=date(2026, 11, 1), end_date=date(2026, 11, 14))
    out = {}

    def patcher():
        c = APIClient()
        c.force_authenticate(tenant_a["owner"])
        c.credentials(HTTP_X_WORKSPACE=tenant_a["workspace"].slug)
        out["res"] = c.patch(f"/api/sprints/{sprint.pk}/", {"name": "Too late"}, format="json")
        connection.close()

    with transaction.atomic():  # what the complete endpoint does, held open
        lock_project(sprint.project_id, exclusive=True)
        Sprint.objects.filter(pk=sprint.pk).update(state=Sprint.State.CLOSED, completed_at=timezone.now())
        thread = threading.Thread(target=patcher)
        thread.start()
        thread.join(1.5)
        assert thread.is_alive()  # waiting for the project lock
    thread.join(10)
    assert out["res"].status_code == 400
    sprint.refresh_from_db()
    assert sprint.state == Sprint.State.CLOSED and sprint.name == "S1"


@pytest.mark.django_db(transaction=True)
def test_concurrent_patch_start_complete(tenant_a):
    from rest_framework.test import APIClient

    sprint = planned(tenant_a)
    codes, barrier = [], threading.Barrier(3)

    def run(fn):
        c = APIClient()
        c.force_authenticate(tenant_a["owner"])
        c.credentials(HTTP_X_WORKSPACE=tenant_a["workspace"].slug)
        barrier.wait()
        for i in range(5):
            codes.append(fn(c, i).status_code)
        connection.close()

    threads = [threading.Thread(target=run, args=(fn,)) for fn in (
        lambda c, i: c.patch(f"/api/sprints/{sprint.pk}/", {"name": f"N{i}", "goal": f"g{i}"}, format="json"),
        lambda c, i: c.post(f"/api/sprints/{sprint.pk}/start/", {}, format="json"),
        lambda c, i: c.post(f"/api/sprints/{sprint.pk}/complete/", {}, format="json"),
    )]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert set(codes) <= {200, 400}, codes
    sprint.refresh_from_db()
    # Whatever the interleaving, the row is consistent: closed <=> completed_at, active/closed have dates.
    assert (sprint.state == Sprint.State.CLOSED) == (sprint.completed_at is not None)
    if sprint.state != Sprint.State.PLANNED:
        assert sprint.start_date and sprint.end_date


# ====================================================== 2-4. limits and CHECKs

class TestGoalAndName:
    def test_goal_limit_on_patch_and_start(self, api, tenant_a):
        sprint = planned(tenant_a)
        url = f"/api/sprints/{sprint.pk}/"
        assert owner(api, tenant_a).patch(url, {"goal": "x" * SPRINT_GOAL_MAX}, format="json").status_code == 200
        res = owner(api, tenant_a).patch(url, {"goal": "x" * (SPRINT_GOAL_MAX + 1)}, format="json")
        assert res.status_code == 400 and "10,000" in str(res.data["goal"])
        res = owner(api, tenant_a).post(f"{url}start/", {"goal": "x" * (SPRINT_GOAL_MAX + 1)}, format="json")
        assert res.status_code == 400
        sprint.refresh_from_db()
        assert sprint.state == Sprint.State.PLANNED

    def test_goal_limit_in_the_db_counts_characters(self, tenant_a):
        qs = Sprint.objects.filter(pk=planned(tenant_a).pk)
        qs.update(goal="é" * SPRINT_GOAL_MAX)
        with pytest.raises(IntegrityError), transaction.atomic():
            qs.update(goal="é" * (SPRINT_GOAL_MAX + 1))

    @pytest.mark.parametrize("name", ["", "   "])
    def test_blank_name_rejected_by_api_and_db(self, api, tenant_a, name):
        sprint = planned(tenant_a)
        assert owner(api, tenant_a).patch(f"/api/sprints/{sprint.pk}/", {"name": name}, format="json").status_code == 400
        with pytest.raises(IntegrityError), transaction.atomic():
            Sprint.objects.filter(pk=sprint.pk).update(name=name)

    def test_blank_name_on_create_still_generates_one(self, api, tenant_a):
        res = owner(api, tenant_a).post("/api/sprints/", {"project": tenant_a["project"].pk, "name": ""}, format="json")
        assert res.status_code == 201 and res.data["name"].strip()


class TestCompletedAt:
    def test_closed_requires_completed_at_and_open_forbids_it(self, tenant_a):
        sprint = planned(tenant_a)
        for change in ({"state": "closed"}, {"completed_at": timezone.now()}):
            with pytest.raises(IntegrityError), transaction.atomic():
                Sprint.objects.filter(pk=sprint.pk).update(**change)

    def test_complete_endpoint_sets_both(self, api, tenant_a):
        sprint = planned(tenant_a, state=Sprint.State.ACTIVE, start_date=date(2026, 11, 1), end_date=date(2026, 11, 14))
        assert owner(api, tenant_a).post(f"/api/sprints/{sprint.pk}/complete/", {}, format="json").status_code == 200
        sprint.refresh_from_db()
        assert sprint.state == Sprint.State.CLOSED and sprint.completed_at is not None


# ============================================================== 5. totals

class TestTotals:
    @pytest.fixture
    def sprint(self, tenant_a):
        sprint = planned(tenant_a)
        done = WorkflowStatus.objects.filter(workflow__project=tenant_a["project"], category="done").first()
        Issue.objects.create(project=tenant_a["project"], title="a", sprint=sprint, story_points=3)
        Issue.objects.create(project=tenant_a["project"], title="b", sprint=sprint, story_points=5, status=done)
        Issue.objects.create(project=tenant_a["project"], title="c", sprint=sprint)
        Issue.objects.create(project=tenant_a["project"], title="backlog", story_points=8)
        return sprint

    def test_values_and_no_big_join(self, api, tenant_a, sprint):
        with CaptureQueriesContext(connection) as queries:
            row = next(s for s in owner(api, tenant_a).get("/api/sprints/").data if s["id"] == sprint.pk)
        assert (row["issue_count"], row["done_count"], row["total_points"], row["done_points"]) == (3, 1, 8, 5)
        assert not any("COUNT(DISTINCT" in q["sql"] for q in queries.captured_queries)
        detail = owner(api, tenant_a).get(f"/api/sprints/{sprint.pk}/").data
        assert (detail["issue_count"], detail["done_points"]) == (3, 5)

    def test_empty_sprint_totals_are_zero(self, api, tenant_a):
        row = owner(api, tenant_a).get(f"/api/sprints/{planned(tenant_a).pk}/").data
        assert (row["issue_count"], row["done_count"], row["total_points"], row["done_points"]) == (0, 0, 0, 0)

    @pytest.mark.parametrize("call, expected", [
        (lambda c, s: c.patch(f"/api/sprints/{s.pk}/", {"goal": "g"}, format="json"), 1),
        (lambda c, s: c.post(f"/api/sprints/{s.pk}/start/", {}, format="json"), 1),
        (lambda c, s: c.delete(f"/api/sprints/{s.pk}/"), 0),
    ])
    def test_writes_compute_totals_only_for_their_response(self, api, tenant_a, sprint, call, expected):
        with CaptureQueriesContext(connection) as queries:
            assert call(owner(api, tenant_a), sprint).status_code in (200, 204)
        assert sum('AS "issue_count"' in q["sql"] for q in queries.captured_queries) == expected


# ------------------------------------------------- migration: report, never invent

@pytest.mark.django_db(transaction=True)
def test_migration_reports_bad_sprints_without_changing_them(tenant_a):
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    sprint = planned(tenant_a)
    try:
        MigrationExecutor(connection).migrate([("projects", "0005_status_name_ci_unique_trimmed")])
        with connection.cursor() as cur:
            cur.execute("UPDATE projects_sprint SET state = 'closed', start_date = %s, end_date = %s WHERE id = %s",
                        [date(2026, 1, 1), date(2026, 1, 14), sprint.pk])
        with pytest.raises(RuntimeError, match=str(sprint.pk)):
            latest()
        with connection.cursor() as cur:
            cur.execute("SELECT state, completed_at FROM projects_sprint WHERE id = %s", [sprint.pk])
            assert cur.fetchone() == ("closed", None)  # no invented timestamp
    finally:
        with connection.cursor() as cur:
            cur.execute("UPDATE projects_sprint SET state = 'planned' WHERE id = %s", [sprint.pk])
        latest()
