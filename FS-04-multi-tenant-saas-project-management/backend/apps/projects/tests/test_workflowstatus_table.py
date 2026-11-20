"""Schema review, table #11 (projects_workflowstatus): reserved temporary-name prefix, case-insensitive unique
names in the DB, trimmed non-blank names, no redundant workflow_id index, and a migration that reports instead of
renaming."""
import pytest
from django.db import IntegrityError, connection, transaction

from apps.projects.models import RESERVED_STATUS_PREFIX, WorkflowStatus

pytestmark = pytest.mark.django_db


def editor(api, tenant):
    client = api(tenant["owner"], tenant["workspace"])
    url = f"/api/projects/{tenant['project'].key}/workflow/"
    return client, url


def current(client, url):
    return [{"id": s["id"], "name": s["name"], "category": s["category"]} for s in client.get(url).data["statuses"]]


def save(client, url, statuses):
    return client.put(url, {"enforce_transitions": False, "statuses": statuses}, format="json")


# ---------------------------------------------------------------- 1. reserved prefix

@pytest.mark.parametrize("name", [f"{RESERVED_STATUS_PREFIX}1_1__", f"  {RESERVED_STATUS_PREFIX}x", "__WORKFLOW_TMP_x"])
def test_reserved_prefix_is_a_clear_400(api, tenant_a, name):
    client, url = editor(api, tenant_a)
    res = save(client, url, [{"name": name, "category": "todo"}] + current(client, url))
    assert res.status_code == 400 and "__workflow_tmp_" in str(res.data["statuses"])


def test_the_reproduced_collision_no_longer_happens(api, tenant_a):
    """Was a 409 from the temporary rename; now rejected up front with a field error."""
    client, url = editor(api, tenant_a)
    wf = tenant_a["project"].workflow.pk
    res = save(client, url, [{"name": f"{RESERVED_STATUS_PREFIX}{wf}_1__", "category": "todo"}] + current(client, url))
    assert res.status_code == 400


# -------------------------------------- the important one: swap names + create, CI index

def test_swap_two_names_and_create_a_status_in_one_save(api, tenant_a):
    client, url = editor(api, tenant_a)
    statuses = current(client, url)
    first, second = statuses[0], statuses[1]
    first["name"], second["name"] = second["name"], first["name"]  # a straight swap
    statuses.append({"name": "Review", "category": "in_progress"})
    res = save(client, url, statuses)
    assert res.status_code == 200, res.data
    names = {s["id"]: s["name"] for s in res.data["statuses"]}
    assert names[first["id"]] == first["name"] and names[second["id"]] == second["name"]
    assert "Review" in names.values()


def test_case_only_swap_and_case_change(api, tenant_a):
    client, url = editor(api, tenant_a)
    statuses = current(client, url)
    statuses[0]["name"], statuses[1]["name"] = statuses[1]["name"].upper(), statuses[0]["name"].lower()
    assert save(client, url, statuses).status_code == 200


# ------------------------------------------------------- 2. case-insensitive in the DB

def test_db_rejects_names_differing_only_in_case(tenant_a):
    first, second = list(WorkflowStatus.objects.filter(workflow=tenant_a["project"].workflow)[:2])
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkflowStatus.objects.filter(pk=second.pk).update(name=first.name.upper())


def test_editor_reports_case_duplicates_as_400(api, tenant_a):
    client, url = editor(api, tenant_a)
    statuses = current(client, url)
    res = save(client, url, statuses + [{"name": statuses[0]["name"].swapcase(), "category": "todo"}])
    assert res.status_code == 400 and "unique" in str(res.data["statuses"])


def test_same_name_in_another_workflow_is_fine(tenant_a):
    from apps.projects.services import create_project

    other = create_project(workspace=tenant_a["workspace"], name="Other", key="OTH", created_by=tenant_a["owner"])
    names = set(WorkflowStatus.objects.filter(workflow=tenant_a["project"].workflow).values_list("name", flat=True))
    assert names & set(WorkflowStatus.objects.filter(workflow=other.workflow).values_list("name", flat=True))


# --------------------------------------------------------------- 3. trimmed, not blank

# PostgreSQL trim() removes spaces only; tabs and other whitespace are stripped by the editor (test below).
@pytest.mark.parametrize("bad", ["", "   ", " Done", "Done "])
def test_db_rejects_blank_and_padded_names(tenant_a, bad):
    status = WorkflowStatus.objects.filter(workflow=tenant_a["project"].workflow).first()
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkflowStatus.objects.filter(pk=status.pk).update(name=bad)


def test_editor_trims_names(api, tenant_a):
    client, url = editor(api, tenant_a)
    res = save(client, url, current(client, url) + [{"name": "\t Review \n", "category": "in_progress"}])
    assert res.status_code == 200
    assert WorkflowStatus.objects.filter(workflow=tenant_a["project"].workflow, name="Review").exists()


# ------------------------------------------------------------------- 4. indexes

def test_indexes():
    with connection.cursor() as cur:
        cur.execute("SELECT indexdef FROM pg_indexes WHERE tablename = 'projects_workflowstatus'")
        defs = [r[0] for r in cur.fetchall()]
        cur.execute("SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'uq_status_position_per_workflow'")
        position = cur.fetchone()
    assert not any(d.endswith("btree (workflow_id)") for d in defs)
    assert any("uq_status_name_ci_per_workflow" in d and "lower((name)::text)" in d for d in defs)
    assert any(d.endswith("btree (workspace_id)") for d in defs)  # kept
    assert position == (True, True)  # the position constraint is still deferred, independently


# ------------------------------------------------- migration: report, never rename

@pytest.mark.django_db(transaction=True)
def test_migration_reports_conflicts_without_changing_data(tenant_a):
    from django.db.migrations.executor import MigrationExecutor

    def latest():
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    workflow = tenant_a["project"].workflow
    created = []
    try:
        MigrationExecutor(connection).migrate([("projects", "0004_project_name_description_checks_drop_ws_index")])
        with connection.cursor() as cur:
            for name, position in (("REVIEW", 90), ("review", 91), (" Padded", 92)):
                cur.execute("INSERT INTO projects_workflowstatus (created_at, updated_at, workspace_id, workflow_id, "
                            "name, category, color, position) VALUES (now(), now(), %s, %s, %s, 'todo', '#64748b', %s) "
                            "RETURNING id", [workflow.workspace_id, workflow.pk, name, position])
                created.append(cur.fetchone()[0])
        with pytest.raises(RuntimeError) as caught:
            latest()
        message = str(caught.value)
        assert all(str(pk) in message for pk in created) and "REVIEW" in message and " Padded" in message
        with connection.cursor() as cur:
            cur.execute("SELECT name FROM projects_workflowstatus WHERE id = ANY(%s) ORDER BY id", [created])
            assert [r[0] for r in cur.fetchall()] == ["REVIEW", "review", " Padded"]  # untouched
    finally:
        with connection.cursor() as cur:
            cur.execute("DELETE FROM projects_workflowstatus WHERE id = ANY(%s)", [created])
        latest()
