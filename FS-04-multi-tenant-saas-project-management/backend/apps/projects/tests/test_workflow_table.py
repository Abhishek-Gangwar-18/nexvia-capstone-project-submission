"""Schema review, table #13 (projects_workflow): every project has its workflow (deferred DB triggers, any write
path), admin can't create orphans, enforced transition rules can't freeze issues, workflow names not blank."""
import pytest
from django.contrib.admin.sites import site
from django.db import DatabaseError, IntegrityError, connection, transaction

from apps.core.exceptions import PROJECT_WORKFLOW_SQLSTATE
from apps.issues.models import Issue
from apps.projects.models import Board, Project, Workflow, WorkflowStatus
from apps.projects.services import create_project

pytestmark = pytest.mark.django_db


def check_now(*names):
    """Deferred constraint triggers fire at COMMIT; tests run inside a transaction, so fire them explicitly."""
    with connection.cursor() as cur:
        cur.execute(f"SET CONSTRAINTS {', '.join(names) or 'ALL'} IMMEDIATE")


def assert_rejected(fn):
    with pytest.raises(DatabaseError) as caught, transaction.atomic():
        fn()
        check_now("trg_project_has_workflow", "trg_workflow_keeps_project")
    assert getattr(caught.value.__cause__, "sqlstate", None) == PROJECT_WORKFLOW_SQLSTATE


# =================================================== 1. project <-> workflow, in the DB

class TestProjectNeedsWorkflow:
    def test_1_project_without_workflow_rejected_at_commit(self, tenant_a):
        assert_rejected(lambda: Project.objects.create(workspace=tenant_a["workspace"], name="Bare", key="BARE"))
        with connection.cursor() as cur:  # raw SQL is covered too
            sql = ("INSERT INTO projects_project (created_at, updated_at, workspace_id, name, key, description, color, "
                   "issue_counter, is_archived) VALUES (now(), now(), %s, 'Raw', 'RAW', '', '#6366f1', 0, false)")
            assert_rejected(lambda: cur.execute(sql, [tenant_a["workspace"].pk]))

    def test_2_normal_creation_makes_every_required_record(self, tenant_a):
        with transaction.atomic():
            project = create_project(workspace=tenant_a["workspace"], name="Full", key="FULL", created_by=tenant_a["owner"])
            check_now()  # project + workflow in one transaction: passes
        assert Workflow.objects.filter(project=project).count() == 1
        assert WorkflowStatus.objects.filter(workflow__project=project).count() >= 2
        assert Board.objects.filter(project=project).count() == 1

    def test_3_workflow_deletion_alone_rejected(self, tenant_a):
        assert_rejected(lambda: Workflow.objects.filter(project=tenant_a["project"]).delete())
        assert Workflow.objects.filter(project=tenant_a["project"]).exists()

    def test_workflow_cannot_be_moved_off_its_project(self, tenant_a):
        other = create_project(workspace=tenant_a["workspace"], name="Other", key="OTH", created_by=tenant_a["owner"])

        def move():
            Workflow.objects.filter(project=other).delete()  # free the one-to-one slot...
            Workflow.objects.filter(project=tenant_a["project"]).update(project=other)  # ...and steal it
        assert_rejected(move)

    def test_4_project_deletion_cascades(self, api, tenant_a):
        key = tenant_a["project"].key
        with transaction.atomic():
            res = api(tenant_a["owner"], tenant_a["workspace"]).delete(f"/api/projects/{key}/", {"confirm": key},
                                                                       format="json")
            check_now()
        assert res.status_code == 204
        assert not Workflow.objects.filter(project_id=tenant_a["project"].pk).exists()

    def test_project_and_workflow_deleted_together(self, tenant_a):
        project = tenant_a["project"]
        with transaction.atomic():
            Workflow.objects.filter(project=project).delete()
            Project.objects.filter(pk=project.pk).delete()
            check_now()
        assert not Project.objects.filter(pk=project.pk).exists()


@pytest.mark.django_db(transaction=True)
def test_real_commit_rejects_an_orphan_project(tenant_a):
    with pytest.raises(DatabaseError):
        with transaction.atomic():
            Project.objects.create(workspace=tenant_a["workspace"], name="Bare", key="BARE")
    assert not Project.objects.filter(key="BARE").exists()


class TestAdmin:
    def test_no_project_add_and_no_workflow_add_or_delete(self, rf, make_user):
        staff = make_user("staff@x.test", is_staff=True, is_superuser=True)
        request = rf.get("/")
        request.user = staff
        assert not site._registry[Project].has_add_permission(request)
        assert not site._registry[Workflow].has_add_permission(request)
        assert not site._registry[Workflow].has_delete_permission(request)
        assert site._registry[Workflow].has_change_permission(request)  # editing stays


# ===================================================== 2. enforced transition rules

def editor(api, tenant):
    client = api(tenant["owner"], tenant["workspace"])
    url = f"/api/projects/{tenant['project'].key}/workflow/"
    statuses = [{"id": s["id"], "name": s["name"], "category": s["category"]} for s in client.get(url).data["statuses"]]
    return client, url, statuses


def put(client, url, statuses, transitions, enforce=True):
    return client.put(url, {"enforce_transitions": enforce, "statuses": statuses, "transitions": transitions},
                      format="json")


class TestTransitionRules:
    def test_5_enforced_with_zero_transitions_rejected(self, api, tenant_a):
        client, url, statuses = editor(api, tenant_a)
        res = put(client, url, statuses, [])
        assert res.status_code == 400 and "at least one transition" in str(res.data["transitions"])

    def test_6_isolated_status_rejected(self, api, tenant_a):
        client, url, statuses = editor(api, tenant_a)
        chain = [{"from": i, "to": i + 1} for i in range(len(statuses) - 2)]  # leaves the last status out
        res = put(client, url, statuses, chain)
        assert res.status_code == 400 and statuses[-1]["name"] in str(res.data["transitions"])

    def test_7_branching_workflow_accepted(self, api, tenant_a):
        client, url, statuses = editor(api, tenant_a)
        statuses = statuses[:3] + [{"name": "Rejected", "category": "done"}]
        branches = [{"from": 0, "to": 1}, {"from": 1, "to": 2}, {"from": 1, "to": 3}, {"from": 0, "to": 3}]
        assert put(client, url, statuses, branches).status_code == 200

    def test_8_terminal_done_status_accepted(self, api, tenant_a):
        client, url, statuses = editor(api, tenant_a)
        chain = [{"from": i, "to": i + 1} for i in range(len(statuses) - 1)]  # Done: incoming only
        assert put(client, url, statuses, chain).status_code == 200

    def test_9_several_unconnected_statuses_rejected(self, api, tenant_a):
        client, url, statuses = editor(api, tenant_a)
        statuses = statuses + [{"name": "Parked", "category": "todo"}, {"name": "Lost", "category": "done"}]
        res = put(client, url, statuses, [{"from": 0, "to": 1}])
        assert res.status_code == 400
        assert all(name in str(res.data["transitions"]) for name in ("Parked", "Lost"))

    def test_separate_groups_of_connected_statuses_are_accepted(self, api, tenant_a):
        """The agreed rule is participation, not reachability: A->B plus C->D passes."""
        client, url, statuses = editor(api, tenant_a)
        statuses = statuses[:2] + [{"name": "C", "category": "in_progress"}, {"name": "D", "category": "done"}]
        assert put(client, url, statuses, [{"from": 0, "to": 1}, {"from": 2, "to": 3}]).status_code == 200

    def test_self_transitions_never_count(self, api, tenant_a):
        client, url, statuses = editor(api, tenant_a)
        selfish = [{"from": i, "to": i} for i in range(len(statuses))]
        assert put(client, url, statuses, selfish).status_code == 400

    def test_10_unenforced_movement_stays_unrestricted(self, api, tenant_a):
        client, url, statuses = editor(api, tenant_a)
        assert put(client, url, statuses, [], enforce=False).status_code == 200
        issue = Issue.objects.create(project=tenant_a["project"], title="free")
        for target in reversed(statuses):
            assert client.patch(f"/api/issues/{issue.key}/", {"status": target["id"]}, format="json").status_code == 200

    def test_enforced_rules_still_block_moves_without_a_transition(self, api, tenant_a):
        client, url, statuses = editor(api, tenant_a)
        chain = [{"from": i, "to": i + 1} for i in range(len(statuses) - 1)]
        assert put(client, url, statuses, chain).status_code == 200
        issue = Issue.objects.create(project=tenant_a["project"], title="ruled")
        assert client.patch(f"/api/issues/{issue.key}/", {"status": statuses[1]["id"]}, format="json").status_code == 200
        assert client.patch(f"/api/issues/{issue.key}/", {"status": statuses[0]["id"]}, format="json").status_code == 400


# ================================================================ 3. name CHECK

@pytest.mark.parametrize("name", ["", "   "])
def test_blank_workflow_name_rejected(api, tenant_a, name):
    client, url, statuses = editor(api, tenant_a)
    assert client.put(url, {"name": name, "enforce_transitions": False, "statuses": statuses},
                      format="json").status_code == 400
    with pytest.raises(IntegrityError), transaction.atomic():
        Workflow.objects.filter(project=tenant_a["project"]).update(name=name)


# --------------------------------------------- migration: report, never create workflows

@pytest.mark.django_db(transaction=True)
def test_migration_reports_orphans_without_creating_workflows(tenant_a):
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    pid = None
    try:
        MigrationExecutor(connection).migrate([("projects", "0006_sprint_name_goal_completed_checks")])
        with connection.cursor() as cur:
            cur.execute("INSERT INTO projects_project (created_at, updated_at, workspace_id, name, key, description, "
                        "color, issue_counter, is_archived) VALUES (now(), now(), %s, 'Orphan', 'ORPH', '', "
                        "'#6366f1', 0, false) RETURNING id", [tenant_a["workspace"].pk])
            pid = cur.fetchone()[0]
        with pytest.raises(RuntimeError, match="ORPH"):
            latest()
        assert not Workflow.objects.filter(project_id=pid).exists()  # nothing created behind our back
    finally:
        with connection.cursor() as cur:
            cur.execute("DELETE FROM projects_project WHERE id = %s", [pid])
        latest()
