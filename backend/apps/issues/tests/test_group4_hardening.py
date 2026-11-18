"""Group 4 hardening: comments, archived guard, hierarchy, uploads, list caps, labels and field bounds."""
import io
from datetime import date, timedelta
from unittest.mock import patch

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.issues.models import AuditLog, Issue, IssueAttachment, IssueComment, Label
from apps.issues.serializers import shift_years
from apps.tenants.models import Membership, Workspace

Role = Membership.Role
T = Issue.IssueType
pytestmark = pytest.mark.django_db

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
PDF = b"%PDF-1.7\n" + b"x" * 32


@pytest.fixture
def team(tenant_a, make_user, add_member, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    ws = tenant_a["workspace"]
    ws.plan = Workspace.Plan.ENTERPRISE
    ws.save(update_fields=["plan"])
    users = {"owner": tenant_a["owner"]}
    for role in (Role.ADMIN, Role.MEMBER):
        users[role] = make_user(f"{role}@g4.test")
        add_member(ws, users[role], role)
    return {**tenant_a, "users": users}


def client_for(api, team, who="owner"):
    return api(team["users"][who], team["workspace"])


def upload(client, issue, name, content, content_type):
    return client.post(f"/api/issues/{issue.key}/attachments/",
                       {"file": SimpleUploadedFile(name, content, content_type=content_type)}, format="multipart")


# ------------------------------------------------------------------------- 1. comments

class TestCommentRules:
    def test_only_author_edits_admin_can_delete(self, api, team):
        issue = Issue.objects.create(project=team["project"], title="c")
        member = client_for(api, team, Role.MEMBER)
        cid = member.post(f"/api/issues/{issue.key}/comments/", {"body": "mine"}, format="json").data["id"]
        url = f"/api/issues/{issue.key}/comments/{cid}/"
        admin = client_for(api, team, Role.ADMIN)
        assert admin.patch(url, {"body": "hijacked"}, format="json").status_code == 403
        assert IssueComment.objects.get(pk=cid).body == "mine"
        res = member.patch(url, {"body": "edited"}, format="json")
        assert res.status_code == 200 and res.data["author"]["id"] == team["users"][Role.MEMBER].pk
        assert admin.delete(url).status_code == 204

    def test_only_new_mentions_are_recorded(self, api, team, django_capture_on_commit_callbacks):
        issue = Issue.objects.create(project=team["project"], title="m")
        owner = client_for(api, team)
        admin_email = team["users"][Role.ADMIN].email
        member_email = team["users"][Role.MEMBER].email
        cid = owner.post(f"/api/issues/{issue.key}/comments/", {"body": f"hi @{admin_email}"}, format="json").data["id"]
        with django_capture_on_commit_callbacks() as callbacks:
            owner.patch(f"/api/issues/{issue.key}/comments/{cid}/",
                        {"body": f"hi @{admin_email} and @{member_email}"}, format="json")
        assert callbacks, "the event must be dispatched after commit"
        entry = AuditLog.objects.filter(issue_key=issue.key, changes__edited=True).latest("created_at")
        assert entry.changes["new_mentions"] == [team["users"][Role.MEMBER].pk]


# ---------------------------------------------------------------- 2. archived guard

class TestArchivedIssueWrites:
    def test_blocked(self, api, team):
        issue = Issue.objects.create(project=team["project"], title="a")
        comment = IssueComment.objects.create(issue=issue, author=team["owner"], body="x")
        attachment = IssueAttachment.objects.create(
            workspace=team["workspace"], issue=issue, uploaded_by=team["owner"], original_name="a.png",
            content_type="image/png", size=len(PNG), file=SimpleUploadedFile("a.png", PNG),
        )
        team["project"].is_archived = True
        team["project"].save(update_fields=["is_archived"])
        owner = client_for(api, team)
        responses = [
            owner.post(f"/api/issues/{issue.key}/comments/", {"body": "x"}, format="json"),
            owner.patch(f"/api/issues/{issue.key}/comments/{comment.pk}/", {"body": "y"}, format="json"),
            owner.delete(f"/api/issues/{issue.key}/comments/{comment.pk}/"),
            upload(owner, issue, "b.png", PNG, "image/png"),
            owner.delete(f"/api/attachments/{attachment.pk}/"),
            owner.delete(f"/api/issues/{issue.key}/"),
        ]
        for res in responses:
            assert res.status_code == 400 and res.data["project"] == ["Restore the project first."], res.data
        # Reads still work.
        assert owner.get(f"/api/issues/{issue.key}/comments/").status_code == 200
        assert owner.get(f"/api/attachments/{attachment.pk}/download/").status_code == 200


# ------------------------------------------------------------------- 3. hierarchy

class TestHierarchy:
    def make(self, team, issue_type, parent=None, title="i"):
        return Issue.objects.create(project=team["project"], title=title, issue_type=issue_type, parent=parent)

    @pytest.mark.parametrize("parent_type, child_type, ok", [
        (T.EPIC, T.STORY, True), (T.EPIC, T.TASK, True), (T.EPIC, T.BUG, True),
        (T.EPIC, T.SUBTASK, False), (T.EPIC, T.EPIC, False),
        (T.STORY, T.SUBTASK, True), (T.TASK, T.SUBTASK, True), (T.BUG, T.SUBTASK, True),
        (T.STORY, T.TASK, False), (T.SUBTASK, T.SUBTASK, False),
    ])
    def test_matrix(self, api, team, parent_type, child_type, ok):
        parent = self.make(team, parent_type)
        res = client_for(api, team).post("/api/issues/", {
            "project": team["project"].pk, "title": "child", "issue_type": child_type, "parent": parent.pk,
        }, format="json")
        assert (res.status_code == 201) is ok, res.data

    def test_cycle_is_rejected(self, api, team):
        # Legacy data could hold story->story; the cycle walk catches loops the type rules wouldn't.
        a = self.make(team, T.STORY, title="a")
        b = self.make(team, T.STORY, parent=a, title="b")
        with patch("apps.issues.services.ALLOWED_CHILDREN", {k: set(T) for k in T}):
            res = client_for(api, team).patch(f"/api/issues/{a.key}/", {"parent": b.pk}, format="json")
        assert res.status_code == 400 and "cycle" in str(res.data["parent"])

    def test_type_change_must_fit_children(self, api, team):
        story = self.make(team, T.STORY)
        self.make(team, T.SUBTASK, parent=story)
        owner = client_for(api, team)
        res = owner.patch(f"/api/issues/{story.key}/", {"issue_type": "subtask"}, format="json")
        assert res.status_code == 400 and "issue_type" in res.data
        assert owner.patch(f"/api/issues/{story.key}/", {"issue_type": "bug"}, format="json").status_code == 200

    def test_hierarchy_checked_under_project_lock(self, api, team):
        epic = self.make(team, T.EPIC)
        story = self.make(team, T.STORY)
        calls = []
        real = __import__("apps.issues.views", fromlist=["validate_hierarchy"]).validate_hierarchy
        with patch("apps.issues.views.lock_project", side_effect=lambda pk, **k: calls.append("lock") or
                   __import__("apps.projects.services", fromlist=["lock_project"]).lock_project(pk, **k)), \
             patch("apps.issues.views.validate_hierarchy", side_effect=lambda **k: calls.append("check") or real(**k)):
            client_for(api, team).patch(f"/api/issues/{story.key}/", {"parent": epic.pk}, format="json")
        assert calls == ["lock", "check"]

    def test_unrelated_edit_of_legacy_issue_still_works(self, api, team):
        epic = self.make(team, T.EPIC)
        legacy = self.make(team, T.SUBTASK, parent=epic)  # allowed by the old rules
        res = client_for(api, team).patch(f"/api/issues/{legacy.key}/", {"title": "renamed"}, format="json")
        assert res.status_code == 200


# -------------------------------------------------------------- 4 and 11. uploads

class TestUploads:
    @pytest.mark.parametrize("name, content, ctype", [
        ("evil.png", b"<html><script>alert(1)</script></html>", "image/png"),
        ("evil.png", b"<html></html>", "application/octet-stream"),
        ("x.pdf", PNG, "application/pdf"),
        ("x.txt", b"hello\x00world", "text/plain"),
        ("x.txt", b"\xff\xfe\xfa bad utf8", "text/plain"),
        ("x.svg", b"<svg onload=alert(1)></svg>", "image/svg+xml"),
        ("x.html", b"<p>hi</p>", "text/html"),
    ])
    def test_rejected(self, api, team, name, content, ctype):
        issue = Issue.objects.create(project=team["project"], title="u")
        assert upload(client_for(api, team), issue, name, content, ctype).status_code == 400

    @pytest.mark.parametrize("name, content, ctype, stored", [
        ("a.png", PNG, "application/octet-stream", "image/png"),
        ("a.pdf", PDF, "application/pdf", "application/pdf"),
        ("notes.md", "héllo".encode(), "text/plain", "text/markdown"),
        ("a.webp", b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 16, "image/webp", "image/webp"),
    ])
    def test_accepted_with_verified_type(self, api, team, name, content, ctype, stored):
        issue = Issue.objects.create(project=team["project"], title="u")
        res = upload(client_for(api, team), issue, name, content, ctype)
        assert res.status_code == 201, res.data
        assert res.data["content_type"] == stored

    def test_hard_size_limit(self, api, team, settings):
        settings.FILE_UPLOAD_HARD_LIMIT = 10
        issue = Issue.objects.create(project=team["project"], title="u")
        assert upload(client_for(api, team), issue, "a.png", PNG, "image/png").status_code == 400

    def test_db_failure_deletes_stored_file(self, api, team, tmp_path):
        issue = Issue.objects.create(project=team["project"], title="u")
        with patch("apps.issues.views.record_issue_event", side_effect=IntegrityError("boom")):
            res = upload(client_for(api, team), issue, "a.png", PNG, "image/png")
        assert res.status_code == 409  # core exception handler maps IntegrityError to a conflict
        assert not IssueAttachment.objects.exists()
        assert not [p for p in tmp_path.rglob("*") if p.is_file()]


# ----------------------------------------------------------- 5, 6, 8. list bounds

class TestListBounds:
    def test_unpaged_issue_list_needs_a_filter(self, api, team):
        owner = client_for(api, team)
        assert owner.get("/api/issues/").status_code == 400
        assert owner.get("/api/issues/?project=").status_code == 400
        assert owner.get("/api/issues/?project=WEB").status_code == 200
        assert owner.get("/api/issues/?search=x").status_code == 200
        assert owner.get("/api/issues/?page=1").status_code == 200

    def test_cap_and_truncated_header(self, api, team):
        for i in range(4):
            Issue.objects.create(project=team["project"], title=f"i{i}")
        owner = client_for(api, team)
        with patch("apps.core.pagination.CappedListMixin.PLAIN_LIST_CAP", 3):
            res = owner.get("/api/issues/?project=WEB")
            assert len(res.data) == 3 and res["X-Truncated"] == "true"
            assert [i["title"] for i in res.data] == ["i0", "i1", "i2"]  # rank order, deterministic
        with patch("apps.core.pagination.CappedListMixin.PLAIN_LIST_CAP", 4):
            assert "X-Truncated" not in client_for(api, team).get("/api/issues/?project=WEB")

    def test_audit_log_always_paginated(self, api, team):
        owner = client_for(api, team)
        data = owner.get("/api/audit-log/").data
        assert set(data) >= {"count", "results"}
        assert len(owner.get("/api/audit-log/?page=1&page_size=100000").data["results"]) <= 200

    def test_comments_and_activity(self, api, team):
        issue = Issue.objects.create(project=team["project"], title="busy")
        for i in range(3):
            IssueComment.objects.create(issue=issue, author=team["owner"], body=f"c{i}")
        owner = client_for(api, team)
        plain = owner.get(f"/api/issues/{issue.key}/comments/").data
        assert [c["body"] for c in plain] == ["c0", "c1", "c2"]  # conversation order
        paged = owner.get(f"/api/issues/{issue.key}/comments/?page=1&page_size=2").data
        assert paged["count"] == 3 and len(paged["results"]) == 2
        owner.patch(f"/api/issues/{issue.key}/", {"title": "busier"}, format="json")
        activity = owner.get(f"/api/issues/{issue.key}/activity/?page=1").data
        assert activity["count"] >= 1
        assert activity["results"][0]["action"] == "updated"  # newest first


# ------------------------------------------------------------------------ 7. trigram

class TestTrigram:
    def test_indexes_exist_and_are_used(self, team):
        with connection.cursor() as cur:
            cur.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'issues_issue' AND indexname LIKE '%%_trgm'")
            names = {row[0] for row in cur.fetchall()}
            assert names == {"issue_key_trgm", "issue_title_trgm", "issue_description_trgm"}
            cur.execute("SET LOCAL enable_seqscan = off")
            qs = Issue.objects.filter(title__icontains="findable").order_by()
            sql, params = qs.query.sql_with_params()
            cur.execute("EXPLAIN " + sql, params)
            plan = "\n".join(row[0] for row in cur.fetchall())
        assert "issue_title_trgm" in plan, plan


# ------------------------------------------------------------- 9 and 10. labels

class TestLabels:
    @pytest.mark.parametrize("color", ["red", "#fff", "#12345g", "<x>"])
    def test_color(self, api, team, color):
        res = client_for(api, team).post("/api/labels/", {"name": "x", "color": color}, format="json")
        assert res.status_code == 400 and "color" in res.data

    def test_case_insensitive_and_race(self, api, team):
        owner = client_for(api, team)
        assert owner.post("/api/labels/", {"name": "Bug", "color": "#ff0000"}, format="json").data["name"] == "bug"
        assert owner.post("/api/labels/", {"name": "BUG", "color": "#ff0000"}, format="json").status_code == 400
        with patch("apps.issues.serializers.LabelSerializer.validate_name", lambda self, v: v.strip().lower()):
            res = owner.post("/api/labels/", {"name": "bug", "color": "#ff0000"}, format="json")
        assert res.status_code == 400 and "name" in res.data

    def test_db_rejects_mixed_case(self, team):
        # Label.save() now canonicalizes names, so bypass it with a queryset update to reach the DB CHECK.
        label = Label.objects.create(workspace=team["workspace"], name="Mixed")
        assert label.name == "mixed"
        with pytest.raises(IntegrityError), transaction.atomic():
            Label.objects.filter(pk=label.pk).update(name="Mixed")


# --------------------------------------------------------------- 12 and 13. fields

class TestIssueFields:
    def test_put_is_gone(self, api, team):
        issue = Issue.objects.create(project=team["project"], title="p")
        res = client_for(api, team).put(f"/api/issues/{issue.key}/",
                                        {"project": team["project"].pk, "title": "x"}, format="json")
        assert res.status_code == 405

    @pytest.mark.parametrize("points, ok", [
        (0, True), (100, True), (None, True), (101, False), (-1, False), (True, False), (2.5, False), ("3", False),
    ])
    def test_story_points(self, api, team, points, ok):
        issue = Issue.objects.create(project=team["project"], title="p")
        res = client_for(api, team).patch(f"/api/issues/{issue.key}/", {"story_points": points}, format="json")
        assert (res.status_code == 200) is ok, res.data

    def test_due_date_window(self, api, team):
        issue = Issue.objects.create(project=team["project"], title="d")
        owner = client_for(api, team)
        today = timezone.localdate()
        edge = shift_years(today, 10)
        assert owner.patch(f"/api/issues/{issue.key}/", {"due_date": str(edge)}, format="json").status_code == 200
        too_far = edge + timedelta(days=1)
        assert owner.patch(f"/api/issues/{issue.key}/", {"due_date": str(too_far)}, format="json").status_code == 400
        too_old = shift_years(today, -10) - timedelta(days=1)
        assert owner.patch(f"/api/issues/{issue.key}/", {"due_date": str(too_old)}, format="json").status_code == 400
        assert owner.patch(f"/api/issues/{issue.key}/", {"due_date": None}, format="json").status_code == 200

    def test_leap_day_shift(self):
        assert shift_years(date(2028, 2, 29), 10) == date(2038, 2, 28)
        assert shift_years(date(2028, 2, 29), -4) == date(2024, 2, 29)
