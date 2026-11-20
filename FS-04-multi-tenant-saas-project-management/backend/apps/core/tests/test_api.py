import pytest

from apps.issues.models import Issue, Label
from apps.projects.models import Project, Sprint, WorkflowStatus
from apps.tenants.models import Invitation, Membership, Workspace

pytestmark = pytest.mark.django_db
Role = Membership.Role


@pytest.fixture
def team(tenant_a, make_user, add_member):
    """Acme with one user per role."""
    ws = tenant_a["workspace"]
    users = {"owner": tenant_a["owner"]}
    for role in (Role.ADMIN, Role.MEMBER, Role.VIEWER):
        users[role] = make_user(f"{role}@a.test")
        add_member(ws, users[role], role)
    return {**tenant_a, "users": users}


# --------------------------------------------------------------------------- auth

class TestAuth:
    def test_register_with_workspace_then_login_and_me(self, api):
        client = api()
        res = client.post("/api/auth/register/", {
            "email": "New@Example.test", "password": "S3cure-pass!", "first_name": "Nia", "workspace_name": "Nia Co",
        }, format="json")
        assert res.status_code == 201, res.data
        assert res.data["workspace"] == "nia-co"
        assert res.data["user"]["email"] == "new@example.test"

        res = client.post("/api/auth/login/", {"email": "NEW@example.test", "password": "S3cure-pass!"}, format="json")
        assert res.status_code == 200
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        me = client.get("/api/auth/me/")
        assert me.status_code == 200 and me.data["display_name"] == "Nia"

    def test_register_rejects_duplicate_email_and_weak_password(self, api, tenant_a):
        res = api().post("/api/auth/register/", {"email": "owner@a.test", "password": "123", "first_name": "X"})
        assert res.status_code == 400
        assert "email" in res.data

    def test_refresh_rotation_and_logout_blacklists(self, api, make_user):
        make_user("r@a.test")
        client = api()
        tokens = client.post("/api/auth/login/", {"email": "r@a.test", "password": "pass12345"}).data
        refreshed = client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]})
        assert refreshed.status_code == 200 and "refresh" in refreshed.data
        assert client.post("/api/auth/logout/", {"refresh": refreshed.data["refresh"]}).status_code == 204
        assert client.post("/api/auth/refresh/", {"refresh": refreshed.data["refresh"]}).status_code == 401
        # Logging out twice is idempotent; missing or garbage tokens are a 400.
        assert client.post("/api/auth/logout/", {"refresh": refreshed.data["refresh"]}).status_code == 204
        assert client.post("/api/auth/logout/", {}).status_code == 400
        assert client.post("/api/auth/logout/", {"refresh": "not-a-jwt"}).status_code == 400

    def test_logout_all_revokes_every_session(self, api, make_user):
        user = make_user("all@a.test")
        anon = api()
        first = anon.post("/api/auth/login/", {"email": "all@a.test", "password": "pass12345"}).data["refresh"]
        second = anon.post("/api/auth/login/", {"email": "all@a.test", "password": "pass12345"}).data["refresh"]
        assert api(user).post("/api/auth/logout-all/").status_code == 204
        for token in (first, second):
            assert anon.post("/api/auth/refresh/", {"refresh": token}).status_code == 401

    def test_login_is_throttled(self, api, make_user):
        make_user("t@a.test")
        client = api()
        codes = [client.post("/api/auth/login/", {"email": "t@a.test", "password": "wrong"}).status_code for _ in range(6)]
        assert codes[:5] == [401] * 5 and codes[5] == 429

    def test_login_locks_the_email_across_ips(self, api, make_user):
        make_user("lock@a.test")
        bad = {"email": "lock@a.test", "password": "wrong"}
        # Ten failures from ten different IPs stay under the per-IP limit but trip the per-email one.
        for i in range(10):
            assert api().post("/api/auth/login/", bad, REMOTE_ADDR=f"10.0.0.{i}").status_code == 401
        good = {"email": "LOCK@a.test", "password": "pass12345"}
        assert api().post("/api/auth/login/", good, REMOTE_ADDR="10.0.1.1").status_code == 429

    def test_successful_login_resets_failure_count(self, api, make_user):
        make_user("reset@a.test")
        for i in range(9):
            api().post("/api/auth/login/", {"email": "reset@a.test", "password": "x"}, REMOTE_ADDR=f"10.0.2.{i}")
        assert api().post("/api/auth/login/", {"email": "reset@a.test", "password": "pass12345"},
                          REMOTE_ADDR="10.0.3.1").status_code == 200
        assert api().post("/api/auth/login/", {"email": "reset@a.test", "password": "x"},
                          REMOTE_ADDR="10.0.3.2").status_code == 401

    def test_me_hides_is_staff(self, api, make_user):
        assert "is_staff" not in api(make_user()).get("/api/auth/me/").data

    def test_password_reset_flow(self, api, make_user, mailoutbox):
        import re

        user = make_user("forgot@a.test")
        old_refresh = api().post("/api/auth/login/", {"email": "forgot@a.test", "password": "pass12345"}).data["refresh"]
        # Unknown emails get the same 204 and no mail: no account probing.
        assert api().post("/api/auth/password-reset/", {"email": "nobody@a.test"}).status_code == 204
        assert len(mailoutbox) == 0
        assert api().post("/api/auth/password-reset/", {"email": " Forgot@A.test"}).status_code == 204
        assert len(mailoutbox) == 1 and mailoutbox[0].to == ["forgot@a.test"]
        uid, token = re.search(r"/reset-password/([^/\s]+)/([^/\s]+)", mailoutbox[0].body).groups()

        bad = api().post("/api/auth/password-reset/confirm/", {"uid": uid, "token": "nope", "new_password": "N3w-pass-123"})
        assert bad.status_code == 400 and "token" in bad.data
        weak = api().post("/api/auth/password-reset/confirm/", {"uid": uid, "token": token, "new_password": "123"})
        assert weak.status_code == 400 and "new_password" in weak.data

        body = {"uid": uid, "token": token, "new_password": "N3w-pass-123"}
        assert api().post("/api/auth/password-reset/confirm/", body).status_code == 204
        user.refresh_from_db()
        assert user.check_password("N3w-pass-123")
        # Old sessions are revoked and the link is single-use.
        assert api().post("/api/auth/refresh/", {"refresh": old_refresh}).status_code == 401
        assert api().post("/api/auth/password-reset/confirm/", body).status_code == 400

    def test_password_reset_confirm_rejects_garbage_uid(self, api):
        res = api().post("/api/auth/password-reset/confirm/", {"uid": "!!", "token": "x", "new_password": "N3w-pass-123"})
        assert res.status_code == 400 and "token" in res.data

    def test_register_trims_and_rejects_blank_names(self, api):
        base = {"email": "Trim@A.test ", "password": "S3cure-pass!", "first_name": "  Ann  "}
        assert api().post("/api/auth/register/", {**base, "first_name": "   "}).status_code == 400
        assert api().post("/api/auth/register/", {**base, "workspace_name": "   "}).status_code == 400
        res = api().post("/api/auth/register/", {**base, "workspace_name": "  Acme  "})
        assert res.status_code == 201, res.data
        assert res.data["user"]["email"] == "trim@a.test" and res.data["user"]["first_name"] == "Ann"

    def test_register_race_on_unique_email_is_400(self, api, monkeypatch):
        from apps.accounts.serializers import RegisterSerializer
        # Simulate the other request winning between the existence check and the insert.
        monkeypatch.setattr(RegisterSerializer, "validate_email", lambda self, value: value.strip().lower())
        body = {"email": "race@a.test", "password": "S3cure-pass!", "first_name": "R"}
        assert api().post("/api/auth/register/", body).status_code == 201
        res = api().post("/api/auth/register/", body)
        assert res.status_code == 400 and "email" in res.data, res.data

    def test_refresh_for_deleted_user_is_401_not_500(self, api, make_user):
        user = make_user("gone@a.test")
        client = api()
        refresh = client.post("/api/auth/login/", {"email": "gone@a.test", "password": "pass12345"}).data["refresh"]
        user.delete()  # e.g. the demo data was reset while the browser still held a token
        res = client.post("/api/auth/refresh/", {"refresh": refresh})
        assert res.status_code == 401, res.data
        assert "no longer exists" in str(res.data["detail"]), res.data

    def test_anonymous_is_rejected(self, api, tenant_a):
        assert api(workspace=tenant_a["workspace"]).get("/api/projects/").status_code == 401

    def test_change_password(self, api, make_user):
        user = make_user("pw@a.test")
        client = api(user)
        bad = client.post("/api/auth/change-password/", {"current_password": "nope", "new_password": "N3w-pass-123"})
        assert bad.status_code == 400
        old_refresh = api().post("/api/auth/login/", {"email": "pw@a.test", "password": "pass12345"}).data["refresh"]
        ok = client.post("/api/auth/change-password/", {"current_password": "pass12345", "new_password": "N3w-pass-123"})
        assert ok.status_code == 200 and {"access", "refresh"} <= ok.data.keys()
        user.refresh_from_db()
        assert user.check_password("N3w-pass-123")
        # Old sessions are revoked; the freshly issued one still works.
        assert api().post("/api/auth/refresh/", {"refresh": old_refresh}).status_code == 401
        assert api().post("/api/auth/refresh/", {"refresh": ok.data["refresh"]}).status_code == 200


# ---------------------------------------------------------------------- isolation

class TestTenantIsolation:
    def test_header_required(self, api, tenant_a):
        res = api(tenant_a["owner"]).get("/api/projects/")
        assert res.status_code == 400

    def test_non_member_gets_404_for_foreign_workspace(self, api, tenant_a, tenant_b):
        res = api(tenant_a["owner"], tenant_b["workspace"]).get("/api/projects/")
        assert res.status_code == 404

    def test_lists_only_contain_own_rows(self, api, tenant_a, tenant_b):
        Issue.objects.create(project=tenant_a["project"], title="mine")
        Issue.objects.create(project=tenant_b["project"], title="theirs")
        res = api(tenant_a["owner"], tenant_a["workspace"]).get("/api/issues/?project=WEB")
        assert [i["title"] for i in res.data] == ["mine"]

    def test_same_issue_key_resolves_per_tenant(self, api, tenant_a, tenant_b):
        Issue.objects.create(project=tenant_a["project"], title="A one")
        Issue.objects.create(project=tenant_b["project"], title="B one")
        res = api(tenant_b["owner"], tenant_b["workspace"]).get("/api/issues/WEB-1/")
        assert res.data["title"] == "B one"

    def test_foreign_ids_in_payload_are_rejected(self, api, tenant_a, tenant_b):
        client = api(tenant_a["owner"], tenant_a["workspace"])
        foreign_status = tenant_b["project"].default_status
        res = client.post("/api/issues/", {
            "project": tenant_a["project"].id, "title": "x", "status": foreign_status.id,
        }, format="json")
        assert res.status_code == 400 and "status" in res.data
        res = client.post("/api/issues/", {"project": tenant_b["project"].id, "title": "x"}, format="json")
        assert res.status_code == 400 and "project" in res.data
        res = client.post("/api/issues/", {
            "project": tenant_a["project"].id, "title": "x", "assignee": tenant_b["owner"].id,
        }, format="json")
        assert res.status_code == 400 and "assignee" in res.data

    def test_cannot_touch_foreign_issue_by_switching_header(self, api, tenant_a, tenant_b):
        issue = Issue.objects.create(project=tenant_b["project"], title="secret")
        res = api(tenant_a["owner"], tenant_a["workspace"]).patch(f"/api/issues/{issue.key}/", {"title": "pwned"})
        assert res.status_code == 404
        issue.refresh_from_db()
        assert issue.title == "secret"


# -------------------------------------------------------------------- permissions

class TestRolePermissions:
    @pytest.mark.parametrize("role,expected", [(Role.VIEWER, 403), (Role.MEMBER, 403), (Role.ADMIN, 201)])
    def test_only_admins_create_projects(self, api, team, role, expected):
        res = api(team["users"][role], team["workspace"]).post(
            "/api/projects/", {"name": "Ops", "key": "OPS"}, format="json"
        )
        assert res.status_code == expected

    @pytest.mark.parametrize("role,expected", [(Role.VIEWER, 403), (Role.MEMBER, 201), (Role.ADMIN, 201)])
    def test_viewers_cannot_create_issues(self, api, team, role, expected):
        res = api(team["users"][role], team["workspace"]).post(
            "/api/issues/", {"project": team["project"].id, "title": "Hello"}, format="json"
        )
        assert res.status_code == expected

    def test_viewer_can_read(self, api, team):
        assert api(team["users"][Role.VIEWER], team["workspace"]).get("/api/issues/?page=1").status_code == 200

    def test_issue_delete_reporter_or_admin(self, api, team):
        member, other = team["users"][Role.MEMBER], team["users"][Role.ADMIN]
        issue = Issue.objects.create(project=team["project"], title="x", reporter=other)
        assert api(member, team["workspace"]).delete(f"/api/issues/{issue.key}/").status_code == 403
        own = Issue.objects.create(project=team["project"], title="y", reporter=member)
        assert api(member, team["workspace"]).delete(f"/api/issues/{own.key}/").status_code == 204
        assert api(other, team["workspace"]).delete(f"/api/issues/{issue.key}/").status_code == 204

    def test_member_role_rules(self, api, team):
        ws = team["workspace"]
        viewer_m = Membership.objects.get(workspace=ws, user=team["users"][Role.VIEWER])
        owner_m = Membership.objects.get(workspace=ws, user=team["owner"])
        member = api(team["users"][Role.MEMBER], ws)
        admin = api(team["users"][Role.ADMIN], ws)
        assert member.patch(f"/api/members/{viewer_m.id}/", {"role": "admin"}).status_code == 403
        assert admin.patch(f"/api/members/{viewer_m.id}/", {"role": "member"}).status_code == 200
        assert admin.patch(f"/api/members/{viewer_m.id}/", {"role": "owner"}).status_code == 400
        assert admin.delete(f"/api/members/{owner_m.id}/").status_code == 403
        assert admin.delete(f"/api/members/{viewer_m.id}/").status_code == 204

    def test_only_owner_deletes_workspace(self, api, team, django_capture_on_commit_callbacks):
        ws = team["workspace"]
        assert api(team["users"][Role.ADMIN], ws).delete("/api/workspace/").status_code == 403
        Issue.objects.create(project=team["project"], title="cascade me")
        with django_capture_on_commit_callbacks(execute=True):  # runs the (eager) background purge
            assert api(team["owner"], ws).delete("/api/workspace/", {"confirm": ws.slug, "password": "pass12345"}, format="json").status_code == 202
        assert not Workspace.objects.filter(pk=ws.pk).exists()


# ------------------------------------------------------------------------ domain

class TestProjectsAndIssues:
    def test_workspaces_list_shows_role_and_counts(self, api, team, tenant_b):
        res = api(team["users"][Role.MEMBER]).get("/api/workspaces/")
        assert [(w["slug"], w["role"], w["member_count"], w["project_count"]) for w in res.data] == [
            ("acme", "member", 4, 1)
        ]

    def test_create_project_scaffolds_workflow_and_board(self, api, team):
        res = api(team["owner"], team["workspace"]).post(
            "/api/projects/", {"name": "Mobile", "key": "mob", "board_type": "kanban"}, format="json"
        )
        assert res.status_code == 201, res.data
        assert res.data["key"] == "MOB"
        assert [s["name"] for s in res.data["statuses"]] == ["To Do", "In Progress", "In Review", "Done"]
        assert res.data["board"]["board_type"] == "kanban"

    def test_duplicate_project_key_rejected(self, api, team):
        res = api(team["owner"], team["workspace"]).post("/api/projects/", {"name": "x", "key": "WEB"})
        assert res.status_code == 400 and "key" in res.data

    def test_delete_project_with_issues(self, api, team):
        Issue.objects.create(project=team["project"], title="x")
        assert api(team["owner"], team["workspace"]).delete("/api/projects/WEB/", {"confirm": "WEB"}, format="json").status_code == 204
        assert not Project.objects.filter(pk=team["project"].pk).exists()

    def test_issue_crud_and_filters(self, api, team):
        client = api(team["users"][Role.MEMBER], team["workspace"])
        label = Label.objects.create(workspace=team["workspace"], name="backend")
        res = client.post("/api/issues/", {
            "project": team["project"].id, "title": "Build API", "issue_type": "bug", "priority": 5,
            "labels": [label.id], "assignee": team["users"][Role.MEMBER].id, "story_points": 3,
        }, format="json")
        assert res.status_code == 201, res.data
        key = res.data["key"]
        assert res.data["reporter_detail"]["email"] == "member@a.test"
        Issue.objects.create(project=team["project"], title="Other")

        assert len(client.get("/api/issues/?assignee=me").data) == 1
        assert len(client.get("/api/issues/?issue_type=bug").data) == 1
        assert len(client.get(f"/api/issues/?label={label.id}").data) == 1
        assert len(client.get("/api/issues/?search=build").data) == 1
        assert len(client.get("/api/issues/?project=WEB").data) == 2
        page = client.get("/api/issues/?page=1&page_size=1")
        assert page.data["count"] == 2 and len(page.data["results"]) == 1

        res = client.patch(f"/api/issues/{key.lower()}/", {"title": "Build REST API"}, format="json")
        assert res.status_code == 200 and res.data["title"] == "Build REST API"
        assert client.get(f"/api/issues/{key}/").data["children"] == []

    def test_disallowed_transition_is_rejected(self, api, team):
        workflow = team["project"].workflow
        todo, in_progress, _, done = workflow.statuses.all()
        workflow.enforce_transitions = True
        workflow.save()
        workflow.transitions.create(from_status=todo, to_status=in_progress)
        issue = Issue.objects.create(project=team["project"], title="x")
        client = api(team["owner"], team["workspace"])
        assert client.patch(f"/api/issues/{issue.key}/", {"status": done.id}).status_code == 400
        assert client.post(f"/api/issues/{issue.key}/move/", {"status": done.id}).status_code == 400
        assert client.post(f"/api/issues/{issue.key}/move/", {"status": in_progress.id}).status_code == 200

    def test_move_reorders_between_neighbours_and_changes_status(self, api, team):
        project = team["project"]
        a, b, c = (Issue.objects.create(project=project, title=t) for t in "abc")
        done = project.workflow.statuses.get(category=WorkflowStatus.Category.DONE)
        client = api(team["owner"], team["workspace"])
        res = client.post(f"/api/issues/{c.key}/move/", {"prev_id": a.id, "next_id": b.id}, format="json")
        assert res.status_code == 200
        assert list(Issue.objects.filter(project=project).values_list("title", flat=True)) == ["a", "c", "b"]
        res = client.post(f"/api/issues/{a.key}/move/", {"status": done.id}, format="json")
        assert res.data["status"] == done.id and res.data["resolved_at"] is not None

    def test_rank_rebalances_when_gap_exhausted(self, api, team):
        project = team["project"]
        a, b, c = (Issue.objects.create(project=project, title=t) for t in "abc")
        Issue.objects.filter(pk=b.pk).update(rank=a.rank + 1e-9)
        res = api(team["owner"], team["workspace"]).post(
            f"/api/issues/{c.key}/move/", {"prev_id": a.id, "next_id": b.id}, format="json"
        )
        assert res.status_code == 200
        assert list(Issue.objects.filter(project=project).values_list("title", flat=True)) == ["a", "c", "b"]


class TestSprints:
    def test_sprint_lifecycle(self, api, team):
        client = api(team["users"][Role.MEMBER], team["workspace"])
        project = team["project"]
        s1 = client.post("/api/sprints/", {"project": project.id}, format="json").data
        s2 = client.post("/api/sprints/", {"project": project.id, "name": "Next"}, format="json").data
        assert s1["name"] == "WEB Sprint 1"

        done = project.workflow.statuses.get(category=WorkflowStatus.Category.DONE)
        finished = Issue.objects.create(project=project, title="done", sprint_id=s1["id"], status=done, story_points=3)
        unfinished = Issue.objects.create(project=project, title="open", sprint_id=s1["id"], story_points=5)

        started = client.post(f"/api/sprints/{s1['id']}/start/", {}, format="json")
        assert started.status_code == 200 and started.data["state"] == "active"
        assert started.data["total_points"] == 8 and started.data["done_points"] == 3
        assert client.post(f"/api/sprints/{s2['id']}/start/", {}, format="json").status_code == 400
        assert client.get(f"/api/projects/{project.key}/").data["active_sprint"]["id"] == s1["id"]

        res = client.post(f"/api/sprints/{s1['id']}/complete/", {"move_open_issues_to": s2["id"]}, format="json")
        assert res.status_code == 200 and res.data["state"] == "closed"
        unfinished.refresh_from_db()
        finished.refresh_from_db()
        assert unfinished.sprint_id == s2["id"] and finished.sprint_id == s1["id"]

        closed = client.post("/api/issues/", {"project": project.id, "title": "late", "sprint": s1["id"]}, format="json")
        assert closed.status_code == 400

    def test_cannot_delete_active_sprint(self, api, team):
        sprint = Sprint.objects.create(project=team["project"], name="S", state=Sprint.State.ACTIVE, start_date="2026-11-01", end_date="2026-11-14")
        res = api(team["owner"], team["workspace"]).delete(f"/api/sprints/{sprint.id}/")
        assert res.status_code == 400


class TestInvitations:
    def test_invite_preview_register_and_join(self, api, team):
        admin = api(team["users"][Role.ADMIN], team["workspace"])
        res = admin.post("/api/invitations/", {"email": "NEW@hire.test", "role": "member"}, format="json")
        assert res.status_code == 201, res.data
        token = res.data["accept_url"].rsplit("/", 1)[1]  # the one-time link is the only place the token appears
        assert Invitation.objects.get(email="new@hire.test").token_hash != token
        assert admin.post("/api/invitations/", {"email": "new@hire.test"}).status_code == 400

        preview = api().get(f"/api/invitations/preview/{token}/")
        assert preview.data["workspace"] == "Acme" and preview.data["user_exists"] is False

        reg = api().post("/api/auth/register/", {
            "email": "new@hire.test", "password": "S3cure-pass!", "first_name": "New", "invite_token": token,
        }, format="json")
        assert reg.status_code == 201 and reg.data["workspace"] == "acme"
        assert Membership.objects.filter(workspace=team["workspace"], user__email="new@hire.test").exists()
        assert admin.get("/api/invitations/").data == []

    def test_existing_user_accepts_with_matching_email_only(self, api, team, tenant_b):
        admin = api(team["owner"], team["workspace"])
        token = admin.post("/api/invitations/", {"email": "owner@b.test", "role": "viewer"}).data["accept_url"].rsplit("/", 1)[1]
        stranger = team["users"][Role.MEMBER]
        assert api(stranger).post("/api/invitations/accept/", {"token": token}).status_code == 403
        res = api(tenant_b["owner"]).post("/api/invitations/accept/", {"token": token})
        assert res.status_code == 200 and res.data["role"] == "viewer"

    def test_members_cannot_invite(self, api, team):
        res = api(team["users"][Role.MEMBER], team["workspace"]).post("/api/invitations/", {"email": "x@y.test"})
        assert res.status_code == 403


class TestDashboardAndDocs:
    def test_dashboard_aggregates(self, api, team):
        project = team["project"]
        done = project.workflow.statuses.get(category=WorkflowStatus.Category.DONE)
        Issue.objects.create(project=project, title="a", status=done)
        Issue.objects.create(project=project, title="b", assignee=team["owner"])
        res = api(team["owner"], team["workspace"]).get("/api/dashboard/")
        assert res.status_code == 200
        assert res.data["totals"]["total"] == 2 and res.data["totals"]["done"] == 1
        assert res.data["totals"]["mine_open"] == 1
        assert len(res.data["trend"]) == 14
        assert res.data["projects"][0]["total"] == 2

    def test_openapi_schema_builds(self, api, make_user):
        res = api(make_user()).get("/api/schema/")
        assert res.status_code == 200
