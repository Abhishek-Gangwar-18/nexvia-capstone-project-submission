import csv
import io
from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from django.core import mail
from django.utils import timezone

from apps.automation.models import Notification, WorkspaceReport
from apps.automation.tasks import (
    create_overdue_reminders, generate_workspace_report, process_issue_event, send_invitation_email,
    send_notification_email,
)
from apps.issues.models import AuditLog, Issue
from apps.projects.models import Sprint, WorkflowStatus
from apps.tenants.models import Invitation, Membership

pytestmark = pytest.mark.django_db
Role = Membership.Role


@pytest.fixture
def team(tenant_a, make_user, add_member):
    workspace = tenant_a["workspace"]
    users = {"owner": tenant_a["owner"]}
    for role in (Role.ADMIN, Role.MEMBER, Role.VIEWER):
        users[role] = make_user(f"{role}@reports.test")
        add_member(workspace, users[role], role)
    return {**tenant_a, "users": users}


@pytest.fixture
def no_queue(monkeypatch):
    monkeypatch.setattr("apps.automation.views.enqueue", MagicMock(return_value=None))


def done_status(project):
    return project.workflow.statuses.get(category=WorkflowStatus.Category.DONE)


def make_report(api, team, **body):
    res = api(team["owner"], team["workspace"]).post("/api/reports/", body, format="json")
    assert res.status_code == 202, res.data
    generate_workspace_report.apply(args=(res.data["id"],), throw=True)
    return WorkspaceReport.objects.get(pk=res.data["id"])


class TestReports:
    def test_burndown_tracks_points_remaining_per_day(self, api, team, no_queue):
        today = timezone.localdate()
        project = team["project"]
        sprint = Sprint.objects.create(
            project=project, name="S", state=Sprint.State.ACTIVE,
            start_date=today - timedelta(days=2), end_date=today + timedelta(days=2),
        )
        done = Issue.objects.create(project=project, title="a", sprint=sprint, story_points=3, status=done_status(project))
        Issue.objects.filter(pk=done.pk).update(resolved_at=timezone.now() - timedelta(days=1))
        Issue.objects.create(project=project, title="b", sprint=sprint, story_points=5)

        report = make_report(api, team, report_type="sprint_burndown", sprint=sprint.pk)
        assert report.state == "ready" and report.project_id == project.pk and "S" in report.title
        days = report.data["days"]
        assert report.data["total_points"] == 8 and report.data["completed_points"] == 3 and len(days) == 5
        assert [d["remaining_points"] for d in days] == [8, 5, 5, None, None]
        assert days[0]["ideal_points"] == 8 and days[-1]["ideal_points"] == 0

    def test_velocity_counts_delivered_points_of_closed_sprints(self, api, team, no_queue):
        project = team["project"]
        today = timezone.localdate()
        for name, points, offset in (("Old", 3, 30), ("New", 8, 10)):
            sprint = Sprint.objects.create(project=project, name=name, state=Sprint.State.CLOSED,
                                           start_date=today - timedelta(days=offset))
            Issue.objects.create(project=project, title="d", sprint=sprint, story_points=points, status=done_status(project))
            Issue.objects.create(project=project, title="o", sprint=sprint, story_points=100)
        Sprint.objects.create(project=project, name="Active", state=Sprint.State.ACTIVE)

        report = make_report(api, team, report_type="velocity", project=project.pk)
        assert [(s["name"], s["completed_points"], s["open_issues"]) for s in report.data["sprints"]] == [
            ("Old", 3, 1), ("New", 8, 1),
        ]
        assert report.data["average_points"] == 5.5

    def test_required_targets_and_other_tenants_are_rejected(self, api, team, tenant_b, no_queue):
        client = api(team["owner"], team["workspace"])
        planned = Sprint.objects.create(project=team["project"], name="P")
        foreign = Sprint.objects.create(project=tenant_b["project"], name="F", state=Sprint.State.ACTIVE, start_date=timezone.localdate())
        for body in (
            {"report_type": "velocity"}, {"report_type": "sprint_burndown"}, {"report_type": "nope"},
            {"report_type": "sprint_burndown", "sprint": planned.pk},
            {"report_type": "sprint_burndown", "sprint": foreign.pk},
            {"report_type": "velocity", "project": tenant_b["project"].pk},
        ):
            assert client.post("/api/reports/", body, format="json").status_code == 400, body

    def test_reports_are_shared_within_workspace_only(self, api, team, tenant_b, no_queue):
        report = make_report(api, team)
        viewer = api(team["users"][Role.VIEWER], team["workspace"])
        assert viewer.post("/api/reports/", {}, format="json").status_code == 403
        assert viewer.get(f"/api/reports/{report.pk}/").status_code == 200
        assert [r["id"] for r in viewer.get("/api/reports/").data] == [report.pk]
        other = api(tenant_b["owner"], tenant_b["workspace"])
        assert other.get("/api/reports/").data == []
        assert other.get(f"/api/reports/{report.pk}/download/").status_code == 404

    def test_csv_download_escapes_formulas(self, api, team, no_queue):
        team["project"].name = "=HYPERLINK(1)"
        team["project"].save()
        Issue.objects.create(project=team["project"], title="a")
        report = make_report(api, team, report_type="velocity", project=team["project"].pk)
        summary = make_report(api, team)
        client = api(team["owner"], team["workspace"])
        res = client.get(f"/api/reports/{report.pk}/download/")
        assert res.status_code == 200 and res["Content-Type"].startswith("text/csv")
        assert "attachment" in res["Content-Disposition"]
        rows = list(csv.reader(io.StringIO(client.get(f"/api/reports/{summary.pk}/download/").content.decode())))
        assert rows[0] == ["Section", "Item", "Issues"] and rows[1][2] == "1"

    def test_pending_report_cannot_be_downloaded(self, api, team, no_queue):
        client = api(team["owner"], team["workspace"])
        report = client.post("/api/reports/", {}, format="json").data
        assert client.get(f"/api/reports/{report['id']}/download/").status_code == 400

    def test_deleted_sprint_marks_report_failed(self, team):
        report = WorkspaceReport.objects.create(
            workspace=team["workspace"], requested_by=team["owner"], report_type="sprint_burndown",
        )
        generate_workspace_report.apply(args=(report.pk,), throw=True)
        report.refresh_from_db()
        assert report.state == "failed" and "deleted" in report.error


class TestAuditLog:
    def events(self, api, team, query=""):
        data = api(team["owner"], team["workspace"]).get(f"/api/audit-log/{query}").data
        return data if "page=" in query else data["results"]  # the audit log is always paginated

    def test_only_admins_can_read_and_nobody_can_write(self, api, team):
        for role, expected in ((Role.VIEWER, 403), (Role.MEMBER, 403), (Role.ADMIN, 200)):
            assert api(team["users"][role], team["workspace"]).get("/api/audit-log/").status_code == expected
        client = api(team["owner"], team["workspace"])
        assert client.post("/api/audit-log/", {}, format="json").status_code == 405
        event = AuditLog.objects.first()
        assert client.delete(f"/api/audit-log/{event.pk}/").status_code == 404

    def test_workspace_isolation(self, api, team, tenant_b):
        labels = {e["entity_label"] for e in self.events(api, team)}
        assert "Globex" not in labels

    def test_project_lifecycle_is_recorded_and_survives_deletion(self, api, team):
        client = api(team["owner"], team["workspace"])
        client.post("/api/projects/", {"name": "Ops", "key": "OPS"}, format="json")
        client.patch("/api/projects/OPS/", {"description": "x"}, format="json")
        client.patch("/api/projects/OPS/", {"is_archived": True}, format="json")
        client.patch("/api/projects/OPS/", {"is_archived": False}, format="json")
        assert client.delete("/api/projects/OPS/", {"confirm": "OPS"}, format="json").status_code == 204
        events = self.events(api, team, "?entity_type=project&project=OPS")
        assert [e["action"] for e in events] == ["deleted", "restored", "archived", "updated", "created"]

    def test_sprint_lifecycle_is_recorded(self, api, team):
        client = api(team["owner"], team["workspace"])
        sprint = client.post("/api/sprints/", {"project": team["project"].pk, "name": "S1"}, format="json").data
        Issue.objects.create(project=team["project"], title="open", sprint_id=sprint["id"])
        client.post(f"/api/sprints/{sprint['id']}/start/", {}, format="json")
        client.post(f"/api/sprints/{sprint['id']}/complete/", {}, format="json")
        events = self.events(api, team, "?entity_type=sprint")
        assert [e["action"] for e in events] == ["completed", "started", "created"]
        assert events[0]["changes"] == {"open_issues_moved": 1, "moved_to": "Backlog"}

    def test_member_changes_are_recorded(self, api, team):
        client = api(team["owner"], team["workspace"])
        viewer = Membership.objects.get(workspace=team["workspace"], user=team["users"][Role.VIEWER])
        client.patch(f"/api/members/{viewer.pk}/", {"role": "member"}, format="json")
        client.delete(f"/api/members/{viewer.pk}/")
        member = Membership.objects.get(workspace=team["workspace"], user=team["users"][Role.MEMBER])
        assert api(team["users"][Role.MEMBER], team["workspace"]).delete(f"/api/members/{member.pk}/").status_code == 204
        events = self.events(api, team, "?entity_type=member")
        assert [e["action"] for e in events] == ["left", "removed", "role_changed"]
        assert events[2]["changes"]["role"] == {"from": "viewer", "to": "member"}

    def test_invitation_and_join_are_recorded(self, api, team):
        client = api(team["owner"], team["workspace"])
        client.post("/api/invitations/", {"email": "new@x.test", "role": "member"}, format="json")
        token = Invitation.objects.get(email="new@x.test").token
        api().post("/api/auth/register/", {
            "email": "new@x.test", "password": "S3cure-pass!", "first_name": "N", "invite_token": token,
        }, format="json")
        actions = [e["action"] for e in self.events(api, team)]
        assert "invited" in actions and "joined" in actions

    def test_workflow_label_webhook_and_workspace_changes_are_recorded(self, api, team):
        client = api(team["owner"], team["workspace"])
        workflow = client.get("/api/projects/WEB/workflow/").data
        client.put("/api/projects/WEB/workflow/", workflow, format="json")
        label = client.post("/api/labels/", {"name": "x", "color": "#000000"}, format="json").data
        client.delete(f"/api/labels/{label['id']}/")
        hook = client.post("/api/webhooks/", {"name": "h", "url": "https://h.example.test", "events": []}, format="json").data
        client.post(f"/api/webhooks/{hook['id']}/rotate-secret/")
        client.patch("/api/workspace/", {"name": "Renamed"}, format="json")
        seen = {(e["entity_type"], e["action"]) for e in self.events(api, team)}
        assert {
            ("workflow", "updated"), ("label", "created"), ("label", "deleted"), ("webhook", "created"),
            ("webhook", "secret_rotated"), ("workspace", "updated"),
        } <= seen

    def test_filters_search_and_pagination(self, api, team):
        client = api(team["owner"], team["workspace"])
        client.post("/api/issues/", {"project": team["project"].pk, "title": "Findable thing"}, format="json")
        client.post("/api/labels/", {"name": "other", "color": "#000000"}, format="json")
        assert [e["entity_type"] for e in self.events(api, team, "?search=findable")] == ["issue"]
        assert all(e["action"] == "created" for e in self.events(api, team, "?action=created"))
        assert self.events(api, team, f"?actor={team['users'][Role.MEMBER].pk}") == []
        today = timezone.localdate()
        assert len(self.events(api, team, f"?date_from={today}&date_to={today}")) >= 2
        assert self.events(api, team, f"?date_to={today - timedelta(days=5)}") == []
        page = self.events(api, team, "?page=1&page_size=1")
        assert page["count"] >= 2 and len(page["results"]) == 1
        assert client.get("/api/audit-log/?date_from=nope").status_code == 400

    def test_non_issue_events_fire_no_webhooks_or_notifications(self, api, team):
        client = api(team["owner"], team["workspace"])
        client.post("/api/labels/", {"name": "x", "color": "#000000"}, format="json")
        event = AuditLog.objects.get(entity_type="label")
        process_issue_event.apply(args=(event.pk,), throw=True)
        assert not Notification.objects.exists()


class TestEmail:
    def test_invitation_email_is_queued_after_commit_and_sent(self, api, team, monkeypatch, django_capture_on_commit_callbacks):
        queued = MagicMock(return_value=None)
        monkeypatch.setattr("apps.tenants.views.enqueue", queued)
        client = api(team["owner"], team["workspace"])
        with django_capture_on_commit_callbacks(execute=True):
            res = client.post("/api/invitations/", {"email": "New@x.test", "role": "viewer"}, format="json")
        assert res.status_code == 201 and res.data["email_sent_at"] is None
        assert queued.call_count == 1

        invitation = Invitation.objects.get(email="new@x.test")
        send_invitation_email.apply(args=(invitation.pk,), throw=True)
        message = mail.outbox[0]
        assert message.to == ["new@x.test"] and "Acme" in message.subject
        assert invitation.token in message.body and invitation.token in message.alternatives[0][0]
        invitation.refresh_from_db()
        assert invitation.email_sent_at is not None

    def test_resend_rules(self, api, team, monkeypatch):
        queued = MagicMock(return_value=None)
        monkeypatch.setattr("apps.tenants.views.enqueue", queued)
        invitation = Invitation.objects.create(workspace=team["workspace"], email="a@x.test", invited_by=team["owner"])
        url = f"/api/invitations/{invitation.pk}/resend/"
        assert api(team["users"][Role.MEMBER], team["workspace"]).post(url).status_code == 403
        res = api(team["owner"], team["workspace"]).post(url)
        assert res.status_code == 202 and res.data == {"queued": True}
        invitation.expires_at = timezone.now() - timedelta(days=1)
        invitation.save()
        assert api(team["owner"], team["workspace"]).post(url).status_code == 400

    def test_used_invitation_is_not_emailed(self, team):
        invitation = Invitation.objects.create(
            workspace=team["workspace"], email="a@x.test", accepted_at=timezone.now(),
        )
        send_invitation_email.apply(args=(invitation.pk,), throw=True)
        assert mail.outbox == []

    def _notification(self, team, user):
        return Notification.objects.create(
            workspace=team["workspace"], recipient=user, event_key="x", title="Hello\nthere",
            body="<b>bold</b>", url="/w/acme/dashboard",
        )

    def test_notification_email_is_escaped_sent_once_and_links_absolutely(self, team, settings):
        settings.FRONTEND_URL = "https://app.example.test/"
        item = self._notification(team, team["users"][Role.MEMBER])
        send_notification_email.apply(args=(item.pk,), throw=True)
        send_notification_email.apply(args=(item.pk,), throw=True)
        assert len(mail.outbox) == 1
        message = mail.outbox[0]
        assert message.subject == "Hello there"
        assert "https://app.example.test/w/acme/dashboard" in message.body
        assert "<b>bold</b>" not in message.alternatives[0][0] and "&lt;b&gt;" in message.alternatives[0][0]

    def test_opting_out_stops_email_but_not_the_notification(self, team):
        user = team["users"][Role.MEMBER]
        user.email_notifications = False
        user.save()
        send_notification_email.apply(args=(self._notification(team, user).pk,), throw=True)
        assert mail.outbox == []
        assert Notification.objects.filter(recipient=user).exists()

    def test_profile_toggle(self, api, team):
        client = api(team["users"][Role.MEMBER])
        assert client.get("/api/auth/me/").data["email_notifications"] is True
        assert client.patch("/api/auth/me/", {"email_notifications": False}, format="json").data["email_notifications"] is False

    def test_mention_assignment_and_overdue_email_but_routine_updates_do_not(self, team, monkeypatch):
        queued = MagicMock(return_value=None)
        monkeypatch.setattr("apps.automation.tasks.enqueue", queued)
        member = team["users"][Role.MEMBER]
        issue = Issue.objects.create(project=team["project"], title="a", assignee=member)

        def run(**kwargs):
            event = AuditLog.objects.create(
                workspace=team["workspace"], project=team["project"], issue_key=issue.key, issue_title=issue.title,
                actor=team["owner"], **kwargs,
            )
            process_issue_event.apply(args=(event.pk,), throw=True)

        run(action="updated", changes={"title": {"from": "x", "to": "a"}})
        assert queued.call_count == 0 and "updated" in Notification.objects.get(recipient=member).body
        run(action="updated", changes={"assignee": {"from": None, "to": "M"}})
        assert queued.call_count == 1
        assert Notification.objects.filter(recipient=member, body__contains="assigned you").exists()
        Issue.objects.filter(pk=issue.pk).update(due_date=timezone.localdate() - timedelta(days=1))
        create_overdue_reminders()
        assert queued.call_count == 2
