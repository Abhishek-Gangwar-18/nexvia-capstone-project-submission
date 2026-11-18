"""Group 2 hardening: role matrix, ownership transfer, deletion guard, invitations and workspace limits."""
from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.automation.tasks import purge_expired_invitations
from apps.issues.models import AuditLog, Issue
from apps.projects.models import WorkflowStatus
from apps.tenants.models import Invitation, Membership, Workspace
from apps.tenants.services import create_workspace

Role = Membership.Role
pytestmark = pytest.mark.django_db


@pytest.fixture
def team(tenant_a, make_user, add_member):
    ws = tenant_a["workspace"]
    ws.plan = Workspace.Plan.ENTERPRISE  # no member cap, so invite tests aren't blocked by billing
    ws.save(update_fields=["plan"])
    users = {"owner": tenant_a["owner"]}
    for role in (Role.ADMIN, Role.MEMBER, Role.VIEWER):
        users[role] = make_user(f"{role}@g2.test")
        add_member(ws, users[role], role)
    users["admin2"] = make_user("admin2@g2.test")
    add_member(ws, users["admin2"], Role.ADMIN)
    return {**tenant_a, "users": users}


def membership(team, key):
    return Membership.objects.get(workspace=team["workspace"], user=team["users"][key])


# --------------------------------------------------------------------- 1. role matrix

class TestRoleMatrix:
    def test_admin_cannot_touch_admins(self, api, team):
        admin = api(team["users"][Role.ADMIN], team["workspace"])
        other_admin = membership(team, "admin2")
        assert admin.patch(f"/api/members/{other_admin.id}/", {"role": "viewer"}).status_code == 403
        assert admin.delete(f"/api/members/{other_admin.id}/").status_code == 403
        viewer = membership(team, Role.VIEWER)
        assert admin.patch(f"/api/members/{viewer.id}/", {"role": "admin"}).status_code == 403

    def test_admin_manages_members_and_viewers(self, api, team):
        admin = api(team["users"][Role.ADMIN], team["workspace"])
        viewer, member = membership(team, Role.VIEWER), membership(team, Role.MEMBER)
        assert admin.patch(f"/api/members/{viewer.id}/", {"role": "member"}).status_code == 200
        assert admin.patch(f"/api/members/{member.id}/", {"role": "viewer"}).status_code == 200
        assert admin.delete(f"/api/members/{viewer.id}/").status_code == 204

    def test_owner_manages_admins(self, api, team):
        owner = api(team["owner"], team["workspace"])
        other_admin, viewer = membership(team, "admin2"), membership(team, Role.VIEWER)
        assert owner.patch(f"/api/members/{viewer.id}/", {"role": "admin"}).status_code == 200
        assert owner.patch(f"/api/members/{other_admin.id}/", {"role": "member"}).status_code == 200
        assert owner.delete(f"/api/members/{viewer.id}/").status_code == 204

    def test_nobody_changes_own_role_and_admin_can_leave(self, api, team):
        admin = api(team["users"][Role.ADMIN], team["workspace"])
        mine = membership(team, Role.ADMIN)
        assert admin.patch(f"/api/members/{mine.id}/", {"role": "member"}).status_code == 403
        assert admin.delete(f"/api/members/{mine.id}/").status_code == 204


# ---------------------------------------------------------------- 2. invitation roles

class TestInvitationRoles:
    def test_only_owner_invites_admins(self, api, team):
        ws = team["workspace"]
        res = api(team["users"][Role.ADMIN], ws).post("/api/invitations/", {"email": "x@g2.test", "role": "admin"})
        assert res.status_code == 400 and "role" in res.data
        assert api(team["owner"], ws).post("/api/invitations/", {"email": "x@g2.test", "role": "admin"}).status_code == 201

    def test_admin_invite_dies_when_sender_loses_ownership(self, api, team, make_user):
        ws = team["workspace"]
        invite = Invitation.objects.create(workspace=ws, email="late@g2.test", role=Role.ADMIN, invited_by=team["owner"])
        raw = invite.issue_token()  # only the hash is stored; tests hold the raw token like the email would
        invite.save(update_fields=["token_hash"])
        new_owner = membership(team, Role.ADMIN)
        assert api(team["owner"], ws).post("/api/workspace/transfer-ownership/", {"member_id": new_owner.id}).status_code == 200
        late = make_user("late@g2.test")
        res = api(late).post("/api/invitations/accept/", {"token": raw}, format="json")
        assert res.status_code == 400 and "token" in res.data
        assert not Membership.objects.filter(workspace=ws, user=late).exists()


# --------------------------------------------------------------- 3. ownership transfer

class TestTransferOwnership:
    def test_transfer(self, api, team):
        ws = team["workspace"]
        target = membership(team, Role.MEMBER)
        res = api(team["owner"], ws).post("/api/workspace/transfer-ownership/", {"member_id": target.id})
        assert res.status_code == 200, res.data
        ws.refresh_from_db()
        assert ws.owner == team["users"][Role.MEMBER]
        assert membership(team, Role.MEMBER).role == Role.OWNER
        assert Membership.objects.get(workspace=ws, user=team["owner"]).role == Role.ADMIN
        assert Membership.objects.filter(workspace=ws, role=Role.OWNER).count() == 1
        assert AuditLog.objects.filter(workspace=ws, action=AuditLog.Action.OWNERSHIP_TRANSFERRED).exists()

    def test_rules(self, api, team, tenant_b):
        ws = team["workspace"]
        owner = api(team["owner"], ws)
        assert api(team["users"][Role.ADMIN], ws).post(
            "/api/workspace/transfer-ownership/", {"member_id": membership(team, Role.MEMBER).id}).status_code == 403
        mine = Membership.objects.get(workspace=ws, user=team["owner"])
        assert owner.post("/api/workspace/transfer-ownership/", {"member_id": mine.id}).status_code == 400
        foreign = Membership.objects.get(workspace=tenant_b["workspace"], user=tenant_b["owner"])
        assert owner.post("/api/workspace/transfer-ownership/", {"member_id": foreign.id}).status_code == 400
        assert owner.post("/api/workspace/transfer-ownership/", {}).status_code == 400


# ------------------------------------------------------------------ 4. delete guard

class TestDeleteWorkspace:
    @pytest.mark.parametrize("body, field", [
        ({}, "confirm"),
        ({"confirm": "wrong", "password": "pass12345"}, "confirm"),
        ({"password": "pass12345"}, "confirm"),
        ({"confirm": None, "password": "pass12345"}, "confirm"),
    ])
    def test_needs_slug(self, api, team, body, field):
        res = api(team["owner"], team["workspace"]).delete("/api/workspace/", body, format="json")
        assert res.status_code == 400 and field in res.data

    def test_needs_password(self, api, team):
        ws = team["workspace"]
        res = api(team["owner"], ws).delete("/api/workspace/", {"confirm": ws.slug, "password": "nope"}, format="json")
        assert res.status_code == 400 and "password" in res.data
        assert Workspace.objects.filter(pk=ws.pk).exists()


# --------------------------------------------------------------- 5 and 11. creation

class TestWorkspaceCreation:
    def test_slug_collision_retries(self, make_user, monkeypatch):
        owner = make_user()
        create_workspace(name="Clash", owner=owner)
        # Pretend the existence check missed the competitor's row (the race): the insert must still succeed.
        monkeypatch.setattr(Workspace, "_unique_slug", lambda self: "clash" if not hasattr(self, "_tried") else "clash-2")
        original_save = Workspace.save

        def save(self, *args, **kwargs):
            try:
                return original_save(self, *args, **kwargs)
            finally:
                Workspace._tried = True

        monkeypatch.setattr(Workspace, "save", save)
        ws = create_workspace(name="Clash", owner=owner)
        assert ws.slug == "clash-2"

    def test_blank_name_and_owner_cap(self, api, make_user, settings):
        settings.MAX_OWNED_WORKSPACES = 2
        user = make_user()
        client = api(user)
        assert client.post("/api/workspaces/", {"name": "   "}).status_code == 400
        assert client.post("/api/workspaces/", {"name": " One "}).data["name"] == "One"
        assert client.post("/api/workspaces/", {"name": "Two"}).status_code == 201
        res = client.post("/api/workspaces/", {"name": "Three"})
        assert res.status_code == 400 and "name" in res.data

    def test_cap_counts_owned_not_joined(self, api, team, settings):
        settings.MAX_OWNED_WORKSPACES = 1
        # The member belongs to Acme but owns nothing, so they can still create one.
        assert api(team["users"][Role.MEMBER]).post("/api/workspaces/", {"name": "Mine"}).status_code == 201

    def test_create_is_throttled(self, api, make_user, settings):
        settings.MAX_OWNED_WORKSPACES = 100
        client = api(make_user())
        codes = [client.post("/api/workspaces/", {"name": f"W{i}"}).status_code for i in range(11)]
        assert codes[:10] == [201] * 10 and codes[10] == 429


# --------------------------------------------------------------------- 6. duplicates

class TestInvitationUniqueness:
    def test_db_rejects_two_open_invites(self, team):
        ws = team["workspace"]
        Invitation.objects.create(workspace=ws, email="dup@g2.test")
        with pytest.raises(IntegrityError), transaction.atomic():
            Invitation.objects.create(workspace=ws, email="DUP@g2.test")

    def test_expired_invite_is_replaced(self, api, team):
        ws = team["workspace"]
        old = Invitation.objects.create(workspace=ws, email="again@g2.test", expires_at=timezone.now() - timedelta(days=1))
        assert api(team["owner"], ws).post("/api/invitations/", {"email": "Again@g2.test", "role": "member"}).status_code == 201
        assert not Invitation.objects.filter(pk=old.pk).exists()

    def test_pending_invite_is_400(self, api, team):
        ws = team["workspace"]
        Invitation.objects.create(workspace=ws, email="p@g2.test")
        res = api(team["owner"], ws).post("/api/invitations/", {"email": "p@g2.test", "role": "member"})
        assert res.status_code == 400 and "email" in res.data


# ------------------------------------------------------------------- 7. unassign

class TestRemovalUnassigns:
    def test_issues_unassigned_reporter_kept(self, api, team):
        ws, project, leaver = team["workspace"], team["project"], team["users"][Role.MEMBER]
        done = WorkflowStatus.objects.filter(workflow__project=project, category=WorkflowStatus.Category.DONE).first()
        open_issue = Issue.objects.create(project=project, title="open", assignee=leaver, reporter=leaver)
        closed = Issue.objects.create(project=project, title="closed", assignee=leaver, status=done)
        res = api(team["owner"], ws).delete(f"/api/members/{membership(team, Role.MEMBER).id}/")
        assert res.status_code == 204
        open_issue.refresh_from_db()
        closed.refresh_from_db()
        assert open_issue.assignee is None and open_issue.reporter == leaver
        assert closed.assignee is None and closed.resolved_at is not None
        entry = AuditLog.objects.filter(workspace=ws, action=AuditLog.Action.REMOVED).latest("created_at")
        assert entry.changes["unassigned_issues"] == 2

    def test_leaving_also_unassigns(self, api, team):
        ws, leaver = team["workspace"], team["users"][Role.VIEWER]
        issue = Issue.objects.create(project=team["project"], title="mine", assignee=leaver)
        assert api(leaver, ws).delete(f"/api/members/{membership(team, Role.VIEWER).id}/").status_code == 204
        issue.refresh_from_db()
        assert issue.assignee is None


# ----------------------------------------------------------------- 8. list + purge

class TestInvitationHousekeeping:
    def test_list_hides_expired_and_paginates(self, api, team):
        ws = team["workspace"]
        Invitation.objects.create(workspace=ws, email="live@g2.test")
        Invitation.objects.create(workspace=ws, email="dead@g2.test", expires_at=timezone.now() - timedelta(hours=1))
        owner = api(team["owner"], ws)
        assert [i["email"] for i in owner.get("/api/invitations/").data] == ["live@g2.test"]
        assert owner.get("/api/invitations/?page=1").data["count"] == 1

    def test_purge(self, team):
        ws = team["workspace"]
        old = Invitation.objects.create(workspace=ws, email="old@g2.test", expires_at=timezone.now() - timedelta(days=31))
        recent = Invitation.objects.create(workspace=ws, email="recent@g2.test", expires_at=timezone.now() - timedelta(days=5))
        accepted = Invitation.objects.create(workspace=ws, email="kept@g2.test", accepted_at=timezone.now(),
                                             expires_at=timezone.now() - timedelta(days=60))
        assert purge_expired_invitations() == 1
        assert not Invitation.objects.filter(pk=old.pk).exists()
        assert Invitation.objects.filter(pk__in=[recent.pk, accepted.pk]).count() == 2


# ---------------------------------------------------------------------- 9. resend

class TestResend:
    def test_cooldown_and_expiry_extension(self, api, team, monkeypatch):
        monkeypatch.setattr("apps.tenants.views.enqueue", MagicMock(return_value=None))
        ws = team["workspace"]
        invite = Invitation.objects.create(workspace=ws, email="r@g2.test", expires_at=timezone.now() + timedelta(days=1))
        owner = api(team["owner"], ws)
        assert owner.post(f"/api/invitations/{invite.pk}/resend/").status_code == 202
        invite.refresh_from_db()
        assert invite.expires_at > timezone.now() + timedelta(days=6)
        assert owner.post(f"/api/invitations/{invite.pk}/resend/").status_code == 429
        invite.email_sent_at = timezone.now() - timedelta(seconds=61)
        invite.save(update_fields=["email_sent_at"])
        assert owner.post(f"/api/invitations/{invite.pk}/resend/").status_code == 202


# ------------------------------------------------------------- 10 and 12. public endpoints

class TestPublicInvitationEndpoints:
    @pytest.mark.parametrize("body", [{}, {"token": None}, {"token": ""}, {"token": "   "}, {"token": 123}, {"token": ["x"]}])
    def test_accept_validates_token_shape(self, api, make_user, body):
        res = api(make_user()).post("/api/invitations/accept/", body, format="json")
        assert res.status_code == 400 and "token" in res.data, res.data

    def test_preview_exposes_only_display_fields(self, api, team):
        invite = Invitation.objects.create(workspace=team["workspace"], email="p@g2.test", invited_by=team["owner"])
        raw = invite.issue_token()  # only the hash is stored; tests hold the raw token like the email would
        invite.save(update_fields=["token_hash"])
        data = api().get(f"/api/invitations/preview/{raw}/").data
        assert set(data) == {
            "email", "role", "workspace", "workspace_slug", "invited_by", "is_pending", "user_exists", "expires_at",
        }
        assert raw not in str(data) and invite.token_hash not in str(data) and isinstance(data["invited_by"], str)

    def test_preview_is_throttled(self, api, team):
        invite = Invitation.objects.create(workspace=team["workspace"], email="t@g2.test")
        raw = invite.issue_token()  # only the hash is stored; tests hold the raw token like the email would
        invite.save(update_fields=["token_hash"])
        client = api()
        codes = [client.get(f"/api/invitations/preview/{raw}/").status_code for _ in range(31)]
        assert codes[:30] == [200] * 30 and codes[30] == 429
