"""Schema review, table #15 (projects_board): a board PATCH can't restore pruned WIP limits or overwrite
concurrent changes (lock, re-read, re-validate, changed fields only); WIP JSON shape and non-blank names in the
DB; admin edit-only; redundant project_id index dropped."""
from unittest.mock import patch

import pytest
from django.contrib.admin.sites import site
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext

from apps.projects.models import Board, Project
from apps.projects.services import create_project
from apps.projects.views import BoardViewSet

pytestmark = pytest.mark.django_db


def client_for(api, tenant):
    return api(tenant["owner"], tenant["workspace"])


@pytest.fixture
def setup(api, tenant_a):
    client = client_for(api, tenant_a)
    board = Board.objects.get(project=tenant_a["project"])
    wf_url = f"/api/projects/{tenant_a['project'].key}/workflow/"
    statuses = [{"id": s["id"], "name": s["name"], "category": s["category"]} for s in client.get(wf_url).data["statuses"]]
    return {"client": client, "board": board, "url": f"/api/boards/{board.pk}/", "wf_url": wf_url, "statuses": statuses}


def meanwhile(fn):
    real = BoardViewSet.get_object

    def stale(view):
        obj = real(view)
        fn()
        return obj

    return patch.object(BoardViewSet, "get_object", stale)


def remove_status(setup, status_id):
    kept = [s for s in setup["statuses"] if s["id"] != status_id]
    assert setup["client"].put(setup["wf_url"], {"enforce_transitions": False, "statuses": kept},
                               format="json").status_code == 200


# =========================================================== 1. PATCH concurrency

class TestPatchRaces:
    def test_name_patch_cannot_restore_a_pruned_wip_limit(self, setup):
        removed = setup["statuses"][2]["id"]
        assert setup["client"].patch(setup["url"], {"wip_limits": {str(removed): 3}}, format="json").status_code == 200
        with meanwhile(lambda: remove_status(setup, removed)):
            res = setup["client"].patch(setup["url"], {"name": "Renamed"}, format="json")
        assert res.status_code == 200
        board = Board.objects.get(pk=setup["board"].pk)
        assert board.name == "Renamed" and str(removed) not in board.wip_limits
        assert res.data["wip_limits"] == board.wip_limits

    def test_name_patch_cannot_overwrite_concurrent_board_type_or_wip(self, setup):
        keep = setup["statuses"][1]["id"]

        def other_admin():
            Board.objects.filter(pk=setup["board"].pk).update(board_type="kanban", wip_limits={str(keep): 5})

        with meanwhile(other_admin):
            assert setup["client"].patch(setup["url"], {"name": "Mine"}, format="json").status_code == 200
        board = Board.objects.get(pk=setup["board"].pk)
        assert (board.name, board.board_type, board.wip_limits) == ("Mine", "kanban", {str(keep): 5})

    def test_wip_for_a_status_deleted_before_the_lock_is_rejected(self, setup):
        doomed = setup["statuses"][2]["id"]
        with meanwhile(lambda: remove_status(setup, doomed)):
            res = setup["client"].patch(setup["url"], {"wip_limits": {str(doomed): 2}}, format="json")
        assert res.status_code == 400 and str(doomed) in res.data["wip_limits"]
        assert str(doomed) not in Board.objects.get(pk=setup["board"].pk).wip_limits

    def test_patch_sql_writes_only_submitted_columns(self, setup):
        with CaptureQueriesContext(connection) as queries:
            assert setup["client"].patch(setup["url"], {"name": "N"}, format="json").status_code == 200
        updates = [q["sql"] for q in queries.captured_queries if q["sql"].startswith('UPDATE "projects_board"')]
        assert updates and not any('"wip_limits"' in s or '"board_type"' in s for s in updates)


# ============================================================ 2. WIP JSON shape

class TestWipValues:
    def sid(self, setup):
        return str(setup["statuses"][0]["id"])

    @pytest.mark.parametrize("limits", ["empty", 1, 3])
    def test_valid_values(self, setup, limits):
        value = {} if limits == "empty" else {self.sid(setup): limits}
        assert setup["client"].patch(setup["url"], {"wip_limits": value}, format="json").status_code == 200
        Board.objects.filter(pk=setup["board"].pk).update(wip_limits=value)  # the DB agrees

    @pytest.mark.parametrize("bad", [["junk"], "junk", None, True, 7])
    def test_invalid_whole_values_rejected_by_api(self, setup, bad):
        assert setup["client"].patch(setup["url"], {"wip_limits": bad}, format="json").status_code == 400

    @pytest.mark.parametrize("bad", [0, -2, 2.5, "3", True, [3], {"n": 3}])
    def test_invalid_limit_values_rejected_by_api(self, setup, bad):
        res = setup["client"].patch(setup["url"], {"wip_limits": {self.sid(setup): bad}}, format="json")
        assert res.status_code == 400

    def test_null_value_removes_a_limit(self, setup):
        sid = self.sid(setup)
        setup["client"].patch(setup["url"], {"wip_limits": {sid: 4}}, format="json")
        assert setup["client"].patch(setup["url"], {"wip_limits": {sid: None}}, format="json").data["wip_limits"] == {}

    @pytest.mark.parametrize("bad", ['[1]', '"x"', 'null', 'true', '3',
                                     '{"1": "3"}', '{"1": true}', '{"1": null}', '{"1": [3]}', '{"1": {"n": 3}}',
                                     '{"1": 0}', '{"1": -1}', '{"1": 2.5}'])
    def test_raw_sql_rejects_invalid_json(self, setup, bad):
        with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cur:
            cur.execute("UPDATE projects_board SET wip_limits = %s::jsonb WHERE id = %s", [bad, setup["board"].pk])

    @pytest.mark.parametrize("good", ['{}', '{"1": 1}', '{"1": 3, "2": 10}', '{"1": 2.0}'])
    def test_raw_sql_accepts_valid_json(self, setup, good):
        with connection.cursor() as cur:  # 2.0 is integral, so it's accepted
            cur.execute("UPDATE projects_board SET wip_limits = %s::jsonb WHERE id = %s", [good, setup["board"].pk])


# ================================================================ 3. name

@pytest.mark.parametrize("name", ["", "   "])
def test_blank_name_rejected_by_api_and_raw_sql(setup, name):
    assert setup["client"].patch(setup["url"], {"name": name}, format="json").status_code == 400
    with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cur:
        cur.execute("UPDATE projects_board SET name = %s WHERE id = %s", [name, setup["board"].pk])


# ============================================================ 4. admin, lifecycle

def test_admin_edits_but_cannot_add_or_delete(rf, make_user):
    staff = make_user("staff@x.test", is_staff=True, is_superuser=True)
    request = rf.get("/")
    request.user = staff
    admin = site._registry[Board]
    assert not admin.has_add_permission(request) and not admin.has_delete_permission(request)
    assert admin.has_change_permission(request)


def test_project_creation_makes_one_board_and_deletion_removes_it(api, tenant_a):
    project = create_project(workspace=tenant_a["workspace"], name="New", key="NEW", created_by=tenant_a["owner"])
    assert Board.objects.filter(project=project).count() == 1
    res = client_for(api, tenant_a).delete("/api/projects/NEW/", {"confirm": "NEW"}, format="json")
    assert res.status_code == 204
    assert not Board.objects.filter(project_id=project.pk).exists()
    assert not Project.objects.filter(pk=project.pk).exists()


# ================================================================ 5. indexes

def test_indexes_and_constraints():
    with connection.cursor() as cur:
        cur.execute("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'projects_board'")
        defs = dict(cur.fetchall())
        cur.execute("SELECT conname FROM pg_constraint WHERE conrelid = 'projects_board'::regclass AND contype = 'c'")
        checks = {r[0] for r in cur.fetchall()}
    assert [n for n, d in defs.items() if d.endswith("btree (project_id)")] == ["uq_one_board_per_project"]
    assert any(d.endswith("btree (workspace_id)") for d in defs.values())
    assert {"ck_board_type", "ck_board_name_not_blank", "ck_board_wip_limits_object",
            "ck_board_wip_limits_values"} <= checks


# --------------------------------------------- migration: report, never rewrite

@pytest.mark.django_db(transaction=True)
def test_migration_reports_invalid_boards(tenant_a):
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    board = Board.objects.get(project=tenant_a["project"])
    try:
        MigrationExecutor(connection).migrate([("projects", "0008_transition_composite_fks")])
        with connection.cursor() as cur:
            cur.execute("UPDATE projects_board SET wip_limits = '{\"1\": 0}'::jsonb WHERE id = %s", [board.pk])
        with pytest.raises(RuntimeError, match=str(board.pk)):
            latest()
        with connection.cursor() as cur:
            cur.execute("SELECT wip_limits::text FROM projects_board WHERE id = %s", [board.pk])
            assert cur.fetchone()[0] == '{"1": 0}'  # untouched
    finally:
        with connection.cursor() as cur:
            cur.execute("UPDATE projects_board SET wip_limits = '{}'::jsonb WHERE id = %s", [board.pk])
        latest()
