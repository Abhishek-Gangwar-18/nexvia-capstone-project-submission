"""Group 3 hardening: project delete guard, archived read-only, races, workflow/WIP validation, sprint rules."""
from unittest.mock import patch

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext

from apps.issues.models import Issue, IssueAttachment
from apps.projects.models import Board, Project, Sprint, WorkflowStatus
from apps.projects.services import next_sprint_name
from apps.tenants.models import Membership, Workspace

Role = Membership.Role
pytestmark = pytest.mark.django_db


@pytest.fixture
def team(tenant_a, make_user, add_member):
    ws = tenant_a["workspace"]
    ws.plan = Workspace.Plan.ENTERPRISE
    ws.save(update_fields=["plan"])
    users = {"owner": tenant_a["owner"]}
    for role in (Role.ADMIN, Role.MEMBER):
        users[role] = make_user(f"{role}@g3.test")
        add_member(ws, users[role], role)
    return {**tenant_a, "users": users}


def owner(api, team):
    return api(team["owner"], team["workspace"])


def statuses(project):
    return list(project.workflow.statuses.order_by("position"))


# ------------------------------------------------------------------ 1. delete guard

class TestProjectDelete:
    def test_owner_only(self, api, team):
        admin = api(team["users"][Role.ADMIN], team["workspace"])
        assert admin.delete("/api/projects/WEB/", {"confirm": "WEB"}, format="json").status_code == 403

    @pytest.mark.parametrize("body", [{}, {"confirm": "NOPE"}, {"confirm": None}, {"confirm": ""}])
    def test_needs_matching_key(self, api, team, body):
        res = owner(api, team).delete("/api/projects/WEB/", body, format="json")
        assert res.status_code == 400 and "confirm" in res.data
        assert Project.objects.filter(pk=team["project"].pk).exists()

    def test_key_compared_canonically(self, api, team):
        assert owner(api, team).delete("/api/projects/web/", {"confirm": "web"}, format="json").status_code == 204

    def test_files_removed_only_after_commit(self, api, team, django_capture_on_commit_callbacks):
        issue = Issue.objects.create(project=team["project"], title="with file")
        attachment = IssueAttachment.objects.create(
            workspace=team["workspace"], issue=issue, uploaded_by=team["owner"], original_name="a.txt",
            size=1, file=SimpleUploadedFile("a.txt", b"x"),
        )
        storage, name = attachment.file.storage, attachment.file.name
        assert storage.exists(name)
        with django_capture_on_commit_callbacks(execute=False) as callbacks:
            assert owner(api, team).delete("/api/projects/WEB/", {"confirm": "WEB"}, format="json").status_code == 204
        assert storage.exists(name)  # not yet: the transaction hasn't committed
        for callback in callbacks:
            callback()
        assert not storage.exists(name)

    def test_rollback_keeps_file(self, team):
        issue = Issue.objects.create(project=team["project"], title="kept")
        attachment = IssueAttachment.objects.create(
            workspace=team["workspace"], issue=issue, uploaded_by=team["owner"], original_name="b.txt",
            size=1, file=SimpleUploadedFile("b.txt", b"x"),
        )
        storage, name = attachment.file.storage, attachment.file.name
        with pytest.raises(RuntimeError), transaction.atomic():
            attachment.delete()
            raise RuntimeError("abort")
        assert storage.exists(name)
        storage.delete(name)


# ------------------------------------------------------------- 3. archived read-only

class TestArchivedProject:
    @pytest.fixture
    def archived(self, team):
        project = team["project"]
        project.is_archived = True
        project.save(update_fields=["is_archived"])
        return project

    def test_writes_blocked_reads_and_restore_allowed(self, api, team, archived):
        client = owner(api, team)
        sprint = Sprint.objects.create(project=archived, name="S")
        board = Board.objects.get(project=archived)
        blocked = [
            client.post("/api/sprints/", {"project": archived.pk}, format="json"),
            client.patch(f"/api/sprints/{sprint.pk}/", {"goal": "x"}, format="json"),
            client.post(f"/api/sprints/{sprint.pk}/start/", {}, format="json"),
            client.delete(f"/api/sprints/{sprint.pk}/"),
            client.patch(f"/api/boards/{board.pk}/", {"wip_limits": {}}, format="json"),
            client.put("/api/projects/WEB/workflow/", client.get("/api/projects/WEB/workflow/").data, format="json"),
            client.patch("/api/projects/WEB/", {"name": "Renamed"}, format="json"),
        ]
        for res in blocked:
            assert res.status_code == 400 and res.data["project"] == ["Restore the project first."], res.data
        assert client.get("/api/projects/WEB/").status_code == 200
        assert client.patch("/api/projects/WEB/", {"is_archived": False}, format="json").status_code == 200

    def test_complete_blocked(self, api, team, archived):
        sprint = Sprint.objects.create(project=archived, name="S", state=Sprint.State.ACTIVE)
        res = owner(api, team).post(f"/api/sprints/{sprint.pk}/complete/", {}, format="json")
        assert res.status_code == 400 and "project" in res.data


# --------------------------------------------------------------- 4. create races

class TestProjectCreate:
    def test_key_integrity_error_becomes_400(self, api, team):
        # Simulate the race: validation passed, but a parallel request inserted the key first.
        with patch("apps.projects.views.create_project", side_effect=IntegrityError("duplicate key")):
            res = owner(api, team).post("/api/projects/", {"name": "X", "key": "NEW"}, format="json")
        assert res.status_code == 400 and "key" in res.data

    def test_plan_limit_checked_under_workspace_lock(self, api, team):
        ws = team["workspace"]
        ws.plan = Workspace.Plan.FREE
        ws.save(update_fields=["plan"])
        with CaptureQueriesContext(connection) as queries:
            owner(api, team).post("/api/projects/", {"name": "Two", "key": "TWO"}, format="json")
        sql = [q["sql"] for q in queries.captured_queries]
        lock = next(i for i, q in enumerate(sql) if "FOR UPDATE" in q and "tenants_workspace" in q)
        insert = next(i for i, q in enumerate(sql) if q.startswith("INSERT INTO \"projects_project\""))
        assert lock < insert

    def test_db_rejects_lowercase_key(self, team):
        with pytest.raises(IntegrityError), transaction.atomic():
            Project.objects.filter(pk=team["project"].pk).update(key="web")


# -------------------------------------------------------------- 5. sprint locking

class TestSprintLifecycle:
    def test_second_start_and_double_complete(self, api, team):
        client = owner(api, team)
        a = Sprint.objects.create(project=team["project"], name="A")
        b = Sprint.objects.create(project=team["project"], name="B")
        assert client.post(f"/api/sprints/{a.pk}/start/", {}, format="json").status_code == 200
        assert client.post(f"/api/sprints/{b.pk}/start/", {}, format="json").status_code == 400
        assert client.post(f"/api/sprints/{a.pk}/complete/", {}, format="json").status_code == 200
        again = client.post(f"/api/sprints/{a.pk}/complete/", {}, format="json")
        assert again.status_code == 400
        from apps.issues.models import AuditLog
        assert AuditLog.objects.filter(action=AuditLog.Action.COMPLETED, entity_label="A").count() == 1

    def test_start_integrity_error_becomes_400(self, api, team):
        sprint = Sprint.objects.create(project=team["project"], name="A")
        with patch.object(Sprint, "save", side_effect=IntegrityError("one_active_sprint_per_project")):
            res = owner(api, team).post(f"/api/sprints/{sprint.pk}/start/", {}, format="json")
        assert res.status_code == 400


# ---------------------------------------------------------------- 2. sprint delete

class TestSprintDelete:
    def test_only_planned(self, api, team):
        client = owner(api, team)
        planned = Sprint.objects.create(project=team["project"], name="P")
        active = Sprint.objects.create(project=team["project"], name="A", state=Sprint.State.ACTIVE)
        closed = Sprint.objects.create(project=team["project"], name="C", state=Sprint.State.CLOSED)
        assert client.delete(f"/api/sprints/{active.pk}/").status_code == 400
        assert client.delete(f"/api/sprints/{closed.pk}/").status_code == 400
        assert client.delete(f"/api/sprints/{planned.pk}/").status_code == 204
        assert Sprint.objects.filter(pk=closed.pk).exists()


# -------------------------------------------------------------- 11. sprint naming

class TestSprintNaming:
    def test_highest_plus_one_and_blank_rules(self, api, team):
        project, client = team["project"], owner(api, team)
        Sprint.objects.create(project=project, name="WEB Sprint 1")
        Sprint.objects.create(project=project, name="WEB Sprint 3")
        assert next_sprint_name(project) == "WEB Sprint 4"
        res = client.post("/api/sprints/", {"project": project.pk, "name": "   "}, format="json")
        assert res.status_code == 201 and res.data["name"] == "WEB Sprint 4"
        res = client.patch(f"/api/sprints/{res.data['id']}/", {"name": "  "}, format="json")
        assert res.status_code == 400 and "name" in res.data


# ----------------------------------------------------- 6 and 12. workflow replacement

class TestWorkflow:
    def test_validation_query_count_is_flat(self, api, team):
        client = owner(api, team)
        config = client.get("/api/projects/WEB/workflow/").data
        for i in range(6):
            config["statuses"].append({"name": f"Extra {i}", "category": "in_progress", "color": "#123456"})
        assert client.put("/api/projects/WEB/workflow/", config, format="json").status_code == 200
        config = client.get("/api/projects/WEB/workflow/").data
        with CaptureQueriesContext(connection) as queries:
            assert client.put("/api/projects/WEB/workflow/", config, format="json").status_code == 200
        lookups = [q["sql"] for q in queries.captured_queries
                   if q["sql"].startswith("SELECT") and "issues_issue" in q["sql"]]
        assert len(lookups) <= 2, lookups

    def test_status_deleted_mid_flight_is_400_not_500(self, api, team):
        project = team["project"]
        issue = Issue.objects.create(project=project, title="t")
        doomed = WorkflowStatus.objects.create(workflow=project.workflow, name="Doomed", category="in_progress", position=9)
        client = api(team["owner"], team["workspace"])
        # The serializer saw the status; a workflow replacement deletes it before the issue update locks.
        real_lock = __import__("apps.issues.views", fromlist=["lock_project"]).lock_project

        def lock_then_delete(pk, **kwargs):
            locked = real_lock(pk, **kwargs)
            WorkflowStatus.objects.filter(pk=doomed.pk).delete()
            return locked

        with patch("apps.issues.views.lock_project", side_effect=lock_then_delete):
            res = client.patch(f"/api/issues/{issue.key}/", {"status": doomed.pk}, format="json")
        assert res.status_code == 400 and "status" in res.data

    def test_workflow_put_takes_project_lock(self, api, team):
        client = owner(api, team)
        config = client.get("/api/projects/WEB/workflow/").data
        with CaptureQueriesContext(connection) as queries:
            client.put("/api/projects/WEB/workflow/", config, format="json")
        assert any("projects_project" in q["sql"] and "FOR UPDATE" in q["sql"] and "NO KEY" not in q["sql"]
                   for q in queries.captured_queries)

    def test_removing_a_status_prunes_wip_limits(self, api, team):
        project, client = team["project"], owner(api, team)
        board = Board.objects.get(project=project)
        doomed = statuses(project)[2]
        board.wip_limits = {str(doomed.pk): 3, str(statuses(project)[1].pk): 2}
        board.save()
        config = client.get("/api/projects/WEB/workflow/").data
        config["statuses"] = [s for s in config["statuses"] if s["id"] != doomed.pk]
        config["transitions"] = []
        assert client.put("/api/projects/WEB/workflow/", config, format="json").status_code == 200
        board.refresh_from_db()
        assert board.wip_limits == {str(statuses(project)[1].pk): 2}


# --------------------------------------------------------------------- 7. WIP limits

class TestWipLimits:
    @pytest.mark.parametrize("limits", [
        {"999999": 2}, {"abc": 2}, "nope", [1], {"STATUS": True}, {"STATUS": 0}, {"STATUS": -1}, {"STATUS": "3"},
        {"STATUS": 2.5},
    ])
    def test_rejects(self, api, team, limits):
        board = Board.objects.get(project=team["project"])
        status_id = str(statuses(team["project"])[0].pk)
        if isinstance(limits, dict):
            limits = {status_id if k == "STATUS" else k: v for k, v in limits.items()}
        res = owner(api, team).patch(f"/api/boards/{board.pk}/", {"wip_limits": limits}, format="json")
        assert res.status_code == 400, (limits, res.data)

    def test_accepts_and_null_clears(self, api, team):
        board = Board.objects.get(project=team["project"])
        a, b = (str(s.pk) for s in statuses(team["project"])[:2])
        res = owner(api, team).patch(f"/api/boards/{board.pk}/", {"wip_limits": {a: 3, b: None}}, format="json")
        assert res.status_code == 200 and res.data["wip_limits"] == {a: 3}


# --------------------------------------------------------------- 8, 9, 10. projects

class TestProjectFields:
    @pytest.mark.parametrize("color", ["red", "<x>", "#12345", "#1234567", "#GGGGGG"])
    def test_color_must_be_hex(self, api, team, color):
        res = owner(api, team).patch("/api/projects/WEB/", {"color": color}, format="json")
        assert res.status_code == 400 and "color" in res.data

    def test_lowercase_key_in_url(self, api, team):
        res = owner(api, team).get("/api/projects/web/")
        assert res.status_code == 200 and res.data["key"] == "WEB"

    def test_put_is_gone_but_workflow_put_stays(self, api, team):
        client = owner(api, team)
        assert client.put("/api/projects/WEB/", {"name": "X", "key": "WEB"}, format="json").status_code == 405
        config = client.get("/api/projects/WEB/workflow/").data
        assert client.put("/api/projects/WEB/workflow/", config, format="json").status_code == 200

    def test_lowercase_key_on_create_is_canonical(self, api, team):
        client = owner(api, team)
        assert client.post("/api/projects/", {"name": "Ops", "key": "ops"}, format="json").data["key"] == "OPS"
        res = client.post("/api/projects/", {"name": "Ops 2", "key": "OPS"}, format="json")
        assert res.status_code == 400 and "key" in res.data
