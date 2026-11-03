"""Regressions found while reviewing Phases 4-5."""
import socket
import threading
import urllib.error
import uuid
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import MagicMock

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from kombu.exceptions import OperationalError

from apps.automation.models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport
from apps.automation.tasks import (
    BlockedTarget, create_daily_digests, create_overdue_reminders, deliver_webhook, generate_workspace_report,
    process_issue_event,
)
from apps.issues.models import Issue, IssueAttachment, AuditLog, IssueComment
from apps.projects.models import WorkflowStatus
from apps.tenants.models import Membership

pytestmark = pytest.mark.django_db
Role = Membership.Role


@pytest.fixture
def team(tenant_a, make_user, add_member):
    workspace = tenant_a["workspace"]
    users = {"owner": tenant_a["owner"]}
    for role in (Role.ADMIN, Role.MEMBER):
        users[role] = make_user(f"{role}@regress.test")
        add_member(workspace, users[role], role)
    return {**tenant_a, "users": users}


def remove_member(api, team, user):
    membership = Membership.objects.get(workspace=team["workspace"], user=user)
    assert api(team["owner"], team["workspace"]).delete(f"/api/members/{membership.pk}/").status_code == 204


class TestMoveAudit:
    def test_reorder_only_is_not_logged_as_a_move(self, api, team):
        a = Issue.objects.create(project=team["project"], title="a")
        b = Issue.objects.create(project=team["project"], title="b")
        res = api(team["owner"], team["workspace"]).post(f"/api/issues/{b.key}/move/", {"next_id": a.pk}, format="json")
        assert res.status_code == 200
        assert not AuditLog.objects.filter(issue_key=b.key, action=AuditLog.Action.MOVED).exists()

    def test_real_move_logs_only_what_changed(self, api, team):
        issue = Issue.objects.create(project=team["project"], title="a")
        done = team["project"].workflow.statuses.get(category=WorkflowStatus.Category.DONE)
        api(team["owner"], team["workspace"]).post(f"/api/issues/{issue.key}/move/", {"status": done.pk}, format="json")
        event = AuditLog.objects.get(issue_key=issue.key, action=AuditLog.Action.MOVED)
        assert event.changes == {"status": {"from": "To Do", "to": "Done"}}


class TestBadInput:
    def test_non_numeric_comment_id_is_404(self, api, team):
        issue = Issue.objects.create(project=team["project"], title="a")
        res = api(team["owner"], team["workspace"]).delete(f"/api/issues/{issue.key}/comments/abc/")
        assert res.status_code == 404

    def test_non_numeric_notification_id_is_404(self, api, team):
        assert api(team["owner"], team["workspace"]).post("/api/notifications/abc/read/").status_code == 404

    def test_workflow_rejects_non_scalar_status_id(self, api, team):
        res = api(team["owner"], team["workspace"]).put("/api/projects/WEB/workflow/", {
            "enforce_transitions": False,
            "statuses": [
                {"id": [1], "name": "A", "category": "todo"},
                {"name": "B", "category": "done"},
            ],
        }, format="json")
        assert res.status_code == 400

    def test_missing_attachment_file_is_404(self, api, team, settings, tmp_path):
        settings.MEDIA_ROOT = tmp_path
        issue = Issue.objects.create(project=team["project"], title="a")
        attachment = IssueAttachment.objects.create(
            issue=issue, uploaded_by=team["owner"], original_name="a.txt", content_type="text/plain", size=1,
            file=SimpleUploadedFile("a.txt", b"x"),
        )
        attachment.file.storage.delete(attachment.file.name)
        res = api(team["owner"], team["workspace"]).get(f"/api/attachments/{attachment.pk}/download/")
        assert res.status_code == 404


class TestRemovedMember:
    def test_their_issues_stay_editable_and_assignments_are_cleared(self, api, team):
        member = team["users"][Role.MEMBER]
        reported = Issue.objects.create(project=team["project"], title="r", reporter=member)
        assigned = Issue.objects.create(project=team["project"], title="a", assignee=member)
        team["project"].lead = member
        team["project"].save()
        remove_member(api, team, member)

        assigned.refresh_from_db()
        team["project"].refresh_from_db()
        assert assigned.assignee_id is None and team["project"].lead_id is None
        client = api(team["owner"], team["workspace"])
        assert client.patch(f"/api/issues/{reported.key}/", {"title": "new"}, format="json").status_code == 200
        done = team["project"].workflow.statuses.get(category=WorkflowStatus.Category.DONE)
        assert client.post(f"/api/issues/{reported.key}/move/", {"status": done.pk}, format="json").status_code == 200

    def test_their_comment_can_still_be_moderated(self, api, team):
        member = team["users"][Role.MEMBER]
        issue = Issue.objects.create(project=team["project"], title="a")
        comment = IssueComment.objects.create(issue=issue, author=member, body="hi")
        remove_member(api, team, member)
        res = api(team["owner"], team["workspace"]).patch(
            f"/api/issues/{issue.key}/comments/{comment.pk}/", {"body": "edited"}, format="json"
        )
        assert res.status_code == 200

    def test_notification_from_them_can_be_marked_read(self, api, team):
        member = team["users"][Role.MEMBER]
        item = Notification.objects.create(
            workspace=team["workspace"], recipient=team["owner"], actor=member, event_key="x", title="t", body="b",
        )
        remove_member(api, team, member)
        res = api(team["owner"], team["workspace"]).post(f"/api/notifications/{item.pk}/read/")
        assert res.status_code == 200

    def test_webhook_they_created_keeps_working(self, api, team):
        admin = team["users"][Role.ADMIN]
        endpoint = WebhookEndpoint.objects.create(
            workspace=team["workspace"], created_by=admin, name="h", url="https://hooks.example.test",
        )
        remove_member(api, team, admin)
        res = api(team["owner"], team["workspace"]).post(f"/api/webhooks/{endpoint.pk}/rotate-secret/")
        assert res.status_code == 200

    def test_their_queued_report_finishes(self, api, team):
        member = team["users"][Role.MEMBER]
        report = WorkspaceReport.objects.create(workspace=team["workspace"], requested_by=member)
        remove_member(api, team, member)
        generate_workspace_report.apply(args=(report.pk,), throw=True)
        report.refresh_from_db()
        assert report.state == WorkspaceReport.State.READY


class TestBrokerDown:
    @pytest.fixture
    def broken_broker(self):
        return MagicMock(side_effect=OperationalError("broker down"))

    def test_report_request_fails_cleanly(self, api, team, monkeypatch, broken_broker):
        monkeypatch.setattr("apps.automation.views.generate_workspace_report.delay", broken_broker)
        res = api(team["owner"], team["workspace"]).post("/api/reports/")
        assert res.status_code == 202
        assert res.data["state"] == "failed" and res.data["error"]

    def test_webhook_test_fails_cleanly(self, api, team, monkeypatch, broken_broker):
        monkeypatch.setattr("apps.automation.views.deliver_webhook.delay", broken_broker)
        endpoint = WebhookEndpoint.objects.create(workspace=team["workspace"], name="h", url="https://hooks.example.test")
        res = api(team["owner"], team["workspace"]).post(f"/api/webhooks/{endpoint.pk}/test/")
        assert res.status_code == 202
        assert res.data["state"] == "failed" and res.data["last_error"]


class TestNotificationsAndDelivery:
    def _audit(self, team, issue, **kwargs):
        return AuditLog.objects.create(
            workspace=team["workspace"], project=team["project"], issue_key=issue.key, issue_title=issue.title,
            actor=team["owner"], action=AuditLog.Action.COMMENTED, **kwargs,
        )

    def test_deleted_comment_does_not_notify_mentions(self, team):
        member = team["users"][Role.MEMBER]
        issue = Issue.objects.create(project=team["project"], title="a")
        comment = IssueComment.objects.create(issue=issue, author=team["owner"], body="x")
        comment.mentions.add(member)
        audit = self._audit(team, issue, changes={"comment_id": comment.pk, "deleted": True})
        process_issue_event.apply(args=(audit.pk,), throw=True)
        assert not Notification.objects.filter(recipient=member).exists()

    def test_mention_says_so(self, team):
        member = team["users"][Role.MEMBER]
        issue = Issue.objects.create(project=team["project"], title="Fix it")
        comment = IssueComment.objects.create(issue=issue, author=team["owner"], body="x")
        comment.mentions.add(member)
        process_issue_event.apply(args=(self._audit(team, issue, changes={"comment_id": comment.pk}).pk,), throw=True)
        assert "mentioned you" in Notification.objects.get(recipient=member).body

    def test_blocked_target_fails_without_retrying(self, team, monkeypatch):
        endpoint = WebhookEndpoint.objects.create(workspace=team["workspace"], name="h", url="https://hooks.example.test")
        delivery = WebhookDelivery.objects.create(
            workspace=team["workspace"], endpoint=endpoint, event_id="00000000-0000-0000-0000-000000000001",
            event="issue.created", payload={},
        )

        def blocked(_url):
            raise BlockedTarget("Webhook targets must resolve to a public IP address.")

        monkeypatch.setattr("apps.automation.tasks._safe_target", blocked)
        deliver_webhook.apply(args=(delivery.pk,), throw=True)
        delivery.refresh_from_db()
        assert delivery.state == WebhookDelivery.State.FAILED and delivery.attempts == 1

    def test_http_error_body_is_recorded(self, team, monkeypatch):
        endpoint = WebhookEndpoint.objects.create(workspace=team["workspace"], name="h", url="https://hooks.example.test")
        delivery = WebhookDelivery.objects.create(
            workspace=team["workspace"], endpoint=endpoint, event_id="00000000-0000-0000-0000-000000000002",
            event="issue.created", payload={},
        )
        monkeypatch.setattr("apps.automation.tasks._safe_target", lambda _url: None)
        error = urllib.error.HTTPError("https://hooks.example.test", 500, "boom", {}, None)
        monkeypatch.setattr(
            "apps.automation.tasks.urllib.request.build_opener",
            lambda *_a: MagicMock(open=MagicMock(side_effect=error)),
        )
        deliver_webhook.apply(args=(delivery.pk,))
        delivery.refresh_from_db()
        assert delivery.response_status == 500 and delivery.state != WebhookDelivery.State.DELIVERED


class TestScheduledJobs:
    def test_overdue_reminder_once_per_day_and_only_for_open_active_work(self, team):
        member = team["users"][Role.MEMBER]
        past = timezone.localdate() - timedelta(days=2)
        overdue = Issue.objects.create(project=team["project"], title="late", assignee=member, due_date=past)
        done = team["project"].workflow.statuses.get(category=WorkflowStatus.Category.DONE)
        Issue.objects.create(project=team["project"], title="done", assignee=member, due_date=past, status=done)
        Issue.objects.create(project=team["project"], title="nobody", due_date=past)
        create_overdue_reminders()
        create_overdue_reminders()
        reminder = Notification.objects.get(recipient=member)
        assert overdue.key in reminder.title

    def test_archived_project_gets_no_reminders(self, team):
        past = timezone.localdate() - timedelta(days=2)
        Issue.objects.create(project=team["project"], title="late", assignee=team["owner"], due_date=past)
        team["project"].is_archived = True
        team["project"].save()
        create_overdue_reminders()
        assert not Notification.objects.exists()

    def test_digest_is_sent_once_and_only_when_something_happened(self, team):
        AuditLog.objects.all().delete()  # creating the workspace is itself an audited event
        create_daily_digests()
        assert not Notification.objects.exists()
        issue = Issue.objects.create(project=team["project"], title="a")
        AuditLog.objects.create(
            workspace=team["workspace"], project=team["project"], issue_key=issue.key, issue_title=issue.title,
            actor=team["owner"], action=AuditLog.Action.CREATED,
        )
        create_daily_digests()
        create_daily_digests()
        assert Notification.objects.count() == Membership.objects.filter(workspace=team["workspace"]).count()


class TestCommentEditNotifications:
    def test_only_newly_mentioned_people_are_notified(self, api, team):
        admin, member = team["users"][Role.ADMIN], team["users"][Role.MEMBER]
        issue = Issue.objects.create(project=team["project"], title="a")
        client = api(team["owner"], team["workspace"])
        comment = client.post(f"/api/issues/{issue.key}/comments/", {"body": f"hi @{admin.email}"}, format="json").data
        client.patch(
            f"/api/issues/{issue.key}/comments/{comment['id']}/",
            {"body": f"hi @{admin.email} and @{member.email}"}, format="json",
        )
        edit = AuditLog.objects.filter(issue_key=issue.key, changes__edited=True).get()
        process_issue_event.apply(args=(edit.pk,), throw=True)
        assert Notification.objects.filter(recipient=member).exists()
        assert not Notification.objects.filter(recipient=admin).exists()


class TestArchivedProject:
    def test_issues_are_read_only(self, api, team):
        issue = Issue.objects.create(project=team["project"], title="a")
        done = team["project"].workflow.statuses.get(category=WorkflowStatus.Category.DONE)
        team["project"].is_archived = True
        team["project"].save()
        client = api(team["owner"], team["workspace"])
        assert client.get(f"/api/issues/{issue.key}/").status_code == 200
        assert client.patch(f"/api/issues/{issue.key}/", {"title": "x"}, format="json").status_code == 400
        assert client.post(f"/api/issues/{issue.key}/move/", {"status": done.pk}, format="json").status_code == 400
        new = client.post("/api/issues/", {"project": team["project"].pk, "title": "x"}, format="json")
        assert new.status_code == 400


class TestWebhookTargetSafety:
    def _delivery(self, team, url):
        endpoint = WebhookEndpoint.objects.create(workspace=team["workspace"], name="h", url=url, events=["*"])
        return WebhookDelivery.objects.create(
            workspace=team["workspace"], endpoint=endpoint, event_id=uuid.uuid4(), event="webhook.test", payload={},
        )

    @pytest.mark.parametrize("url", [
        "https://127.0.0.1/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://localhost/x",
    ])
    def test_internal_urls_are_rejected_outside_debug(self, api, team, settings, url):
        settings.DEBUG = False
        res = api(team["owner"], team["workspace"]).post("/api/webhooks/", {"name": "x", "url": url, "events": []}, format="json")
        assert res.status_code == 400

    def test_name_resolving_to_internal_ip_is_blocked_at_delivery(self, team, settings, monkeypatch):
        settings.DEBUG = False
        delivery = self._delivery(team, "https://rebind.example.test/x")
        monkeypatch.setattr(
            "apps.automation.tasks.socket.getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("169.254.169.254", 443))]
        )
        deliver_webhook.apply(args=(delivery.pk,), throw=True)
        delivery.refresh_from_db()
        assert delivery.state == WebhookDelivery.State.FAILED and "public IP" in delivery.last_error

    def test_dns_failure_is_retried_not_stuck(self, team, monkeypatch):
        delivery = self._delivery(team, "https://down.example.test/x")

        def no_dns(*_a, **_k):
            raise socket.gaierror("no such host")

        monkeypatch.setattr("apps.automation.tasks.socket.getaddrinfo", no_dns)
        deliver_webhook.apply(args=(delivery.pk,))
        delivery.refresh_from_db()
        assert delivery.state == WebhookDelivery.State.FAILED and delivery.attempts == 6

    def test_connection_goes_to_the_validated_ip_not_a_new_dns_answer(self, team, monkeypatch, settings):
        settings.DEBUG = True  # allows the plain-HTTP loopback receiver used here
        received = {}

        class Receiver(BaseHTTPRequestHandler):
            def do_POST(self):
                received["host"] = self.headers["Host"]
                received["signature"] = self.headers["X-FlowBoard-Signature"]
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(204)
                self.end_headers()

            def log_message(self, *_a):
                pass

        server = HTTPServer(("127.0.0.1", 0), Receiver)
        threading.Thread(target=server.handle_request, daemon=True).start()
        port = server.server_address[1]
        # Only the validation step can resolve this made-up name, so success proves the IP was reused.
        real_getaddrinfo = socket.getaddrinfo
        calls = []

        def fake(host, *args, **kwargs):
            if host == "pinned.example.test":
                calls.append(host)
                return [(2, 1, 6, "", ("127.0.0.1", port))]
            return real_getaddrinfo(host, *args, **kwargs)

        monkeypatch.setattr("apps.automation.tasks.socket.getaddrinfo", fake)
        delivery = self._delivery(team, f"http://pinned.example.test:{port}/hook")
        deliver_webhook.apply(args=(delivery.pk,), throw=True)
        server.server_close()
        delivery.refresh_from_db()
        assert delivery.state == WebhookDelivery.State.DELIVERED
        assert calls == ["pinned.example.test"]
        assert received["host"].startswith("pinned.example.test") and received["signature"].startswith("sha256=")
