"""Schema review, table #14 (projects_workflowtransition): composite FKs keep both statuses and the workspace
consistent with the transition's workflow on every write path; no admin write path; bulk editor writes;
redundant from_status index dropped."""
import pytest
from django.contrib.admin.sites import site
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext

from apps.projects.models import Workflow, WorkflowStatus, WorkflowTransition
from apps.projects.services import create_project

pytestmark = pytest.mark.django_db


@pytest.fixture
def two(tenant_a, tenant_b):
    mine = tenant_a["project"].workflow
    other = create_project(workspace=tenant_a["workspace"], name="Other", key="OTH", created_by=tenant_a["owner"]).workflow
    return {
        "ws": tenant_a["workspace"], "foreign_ws": tenant_b["workspace"], "mine": mine, "other": other,
        "m": list(WorkflowStatus.objects.filter(workflow=mine).order_by("position")),
        "o": list(WorkflowStatus.objects.filter(workflow=other).order_by("position")),
    }


def transition(two, **overrides):
    values = {"workspace": two["ws"], "workflow": two["mine"], "from_status": two["m"][0], "to_status": two["m"][1]}
    values.update(overrides)
    return WorkflowTransition(**values)


def rejected(fn):
    with pytest.raises(IntegrityError), transaction.atomic():
        fn()


# ======================================================= 1. composite FKs, every path

class TestCrossWorkflowRejected:
    def test_bulk_create_with_a_foreign_status(self, two):
        rejected(lambda: WorkflowTransition.objects.bulk_create([transition(two, to_status=two["o"][1])]))
        rejected(lambda: WorkflowTransition.objects.bulk_create([transition(two, from_status=two["o"][0])]))

    def test_raw_sql(self, two):
        sql = ("INSERT INTO projects_workflowtransition (created_at, updated_at, workspace_id, workflow_id, "
               "from_status_id, to_status_id, name) VALUES (now(), now(), %s, %s, %s, %s, '')")
        with connection.cursor() as cur:
            rejected(lambda: cur.execute(sql, [two["ws"].pk, two["mine"].pk, two["m"][0].pk, two["o"][1].pk]))

    def test_queryset_update(self, two):
        row = WorkflowTransition.objects.bulk_create([transition(two)])[0]
        qs = WorkflowTransition.objects.filter(pk=row.pk)
        rejected(lambda: qs.update(to_status=two["o"][1]))
        rejected(lambda: qs.update(from_status=two["o"][0]))
        rejected(lambda: qs.update(workflow=two["other"]))  # statuses no longer match the workflow

    def test_referenced_status_cannot_move_to_another_workflow(self, two):
        WorkflowTransition.objects.bulk_create([transition(two)])
        rejected(lambda: WorkflowStatus.objects.filter(pk=two["m"][1].pk).update(workflow=two["other"]))

    def test_unreferenced_status_rules_unchanged(self, two):
        # The composite unique (id, workflow_id) doesn't restrict statuses that no transition references.
        assert WorkflowStatus.objects.filter(pk=two["m"][2].pk).update(position=99) == 1


class TestWorkspaceConsistency:
    def test_transition_workspace_must_be_its_workflows(self, two):
        rejected(lambda: WorkflowTransition.objects.bulk_create([transition(two, workspace=two["foreign_ws"])]))

    def test_raw_insert_with_another_workspace_rejected(self, two):
        sql = ("INSERT INTO projects_workflowtransition (created_at, updated_at, workspace_id, workflow_id, "
               "from_status_id, to_status_id, name) VALUES (now(), now(), %s, %s, %s, %s, '')")
        with connection.cursor() as cur:
            rejected(lambda: cur.execute(sql, [two["foreign_ws"].pk, two["mine"].pk, two["m"][0].pk, two["m"][1].pk]))


# ============================================================== cascades still work

class TestCascades:
    def test_deleting_a_referenced_status_removes_its_transitions(self, two):
        WorkflowTransition.objects.bulk_create([transition(two), transition(two, from_status=two["m"][1],
                                                                           to_status=two["m"][2])])
        WorkflowStatus.objects.filter(pk=two["m"][1].pk).delete()
        assert not WorkflowTransition.objects.filter(workflow=two["mine"]).exists()

    def test_raw_status_delete_cascades_in_the_db(self, two):
        WorkflowTransition.objects.bulk_create([transition(two)])
        with connection.cursor() as cur:  # no Django collector: the FK's ON DELETE CASCADE does it
            cur.execute("DELETE FROM projects_workflowstatus WHERE id = %s", [two["m"][1].pk])
        assert not WorkflowTransition.objects.filter(workflow=two["mine"]).exists()

    def test_deleting_the_project_removes_everything(self, api, tenant_a, two):
        WorkflowTransition.objects.bulk_create([transition(two)])
        key = tenant_a["project"].key
        res = api(tenant_a["owner"], tenant_a["workspace"]).delete(f"/api/projects/{key}/", {"confirm": key},
                                                                   format="json")
        assert res.status_code == 204
        assert not WorkflowTransition.objects.filter(workflow_id=two["mine"].pk).exists()
        assert not Workflow.objects.filter(pk=two["mine"].pk).exists()


# ===================================================== editor and can_transition

def test_editor_replaces_all_transitions_in_one_insert(api, tenant_a):
    client = api(tenant_a["owner"], tenant_a["workspace"])
    url = f"/api/projects/{tenant_a['project'].key}/workflow/"
    statuses = [{"id": s["id"], "name": s["name"], "category": s["category"]} for s in client.get(url).data["statuses"]]
    first = [{"from": i, "to": i + 1} for i in range(len(statuses) - 1)]
    second = [{"from": i + 1, "to": i} for i in range(len(statuses) - 1)] + first
    assert client.put(url, {"enforce_transitions": True, "statuses": statuses, "transitions": first},
                      format="json").status_code == 200
    with CaptureQueriesContext(connection) as queries:
        res = client.put(url, {"enforce_transitions": True, "statuses": statuses, "transitions": second},
                         format="json")
    assert res.status_code == 200 and len(res.data["transitions"]) == len(second)
    inserts = [q for q in queries.captured_queries if q["sql"].startswith('INSERT INTO "projects_workflowtransition"')]
    assert len(inserts) == 1
    assert WorkflowTransition.objects.filter(workflow=tenant_a["project"].workflow).count() == len(second)


def test_can_transition_uses_the_unique_index(two):
    WorkflowTransition.objects.bulk_create([transition(two)])
    two["mine"].enforce_transitions = True  # unenforced workflows answer without a query
    with CaptureQueriesContext(connection) as queries:
        assert two["mine"].can_transition(two["m"][0], two["m"][1]) is True
    sql = queries.captured_queries[-1]["sql"]
    with connection.cursor() as cur:
        cur.execute("SET LOCAL enable_seqscan = off")
        cur.execute("EXPLAIN " + sql)
        plan = "\n".join(r[0] for r in cur.fetchall())
    assert "unique_transition" in plan, plan


# ================================================================ admin, indexes

def test_admin_has_no_transition_write_path(rf, make_user):
    staff = make_user("staff@x.test", is_staff=True, is_superuser=True)
    request = rf.get("/")
    request.user = staff
    workflow_admin = site._registry[Workflow]
    assert all(inline.model is not WorkflowTransition for inline in workflow_admin.get_inline_instances(request))
    assert WorkflowTransition not in site._registry


def test_indexes_and_constraints():
    with connection.cursor() as cur:
        cur.execute("SELECT indexdef FROM pg_indexes WHERE tablename = 'projects_workflowtransition'")
        defs = [r[0] for r in cur.fetchall()]
        cur.execute("""SELECT conname, confdeltype FROM pg_constraint
                       WHERE conrelid = 'projects_workflowtransition'::regclass AND conname LIKE 'fk_transition_%%'""")
        fks = dict(cur.fetchall())
    assert not any(d.endswith("btree (from_status_id)") for d in defs)
    for kept in ("btree (to_status_id)", "btree (workflow_id)", "btree (workspace_id)"):
        assert any(d.endswith(kept) for d in defs), kept
    assert fks == {"fk_transition_from_status_same_workflow": "c", "fk_transition_to_status_same_workflow": "c",
                   "fk_transition_workflow_same_workspace": "c"}  # c = ON DELETE CASCADE


# ------------------------------------------- migration: report, never delete/repair

@pytest.mark.django_db(transaction=True)
def test_migration_reports_mismatched_transitions(tenant_a):
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    other = create_project(workspace=tenant_a["workspace"], name="Other", key="OTH", created_by=tenant_a["owner"])
    mine = list(WorkflowStatus.objects.filter(workflow=tenant_a["project"].workflow))
    theirs = list(WorkflowStatus.objects.filter(workflow=other.workflow))
    tid = None
    try:
        MigrationExecutor(connection).migrate([("projects", "0007_project_requires_workflow")])
        with connection.cursor() as cur:
            cur.execute("INSERT INTO projects_workflowtransition (created_at, updated_at, workspace_id, workflow_id, "
                        "from_status_id, to_status_id, name) VALUES (now(), now(), %s, %s, %s, %s, '') RETURNING id",
                        [tenant_a["workspace"].pk, tenant_a["project"].workflow.pk, mine[0].pk, theirs[1].pk])
            tid = cur.fetchone()[0]
        with pytest.raises(RuntimeError, match=rf"transition {tid} .*to status {theirs[1].pk} in workflow {other.workflow.pk}"):
            latest()
        assert WorkflowTransition.objects.filter(pk=tid).exists()  # not deleted
    finally:
        with connection.cursor() as cur:
            cur.execute("DELETE FROM projects_workflowtransition WHERE id = %s", [tid])
        latest()
