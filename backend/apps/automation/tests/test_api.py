import uuid
from unittest.mock import MagicMock

import pytest

from apps.automation.models import Notification, WebhookDelivery, WebhookEndpoint, WorkspaceReport
from apps.automation.tasks import deliver_webhook, generate_workspace_report, process_issue_event
from apps.issues.models import Issue, AuditLog, IssueComment
from apps.tenants.models import Membership

pytestmark = pytest.mark.django_db


@pytest.fixture
def team(tenant_a, make_user, add_member):
    workspace = tenant_a["workspace"]
    users = {"owner": tenant_a["owner"]}
    for role in (Membership.Role.ADMIN, Membership.Role.MEMBER, Membership.Role.VIEWER):
        user = make_user(f"{role}@automation.test")
        add_member(workspace, user, role)
        users[role] = user
    return {**tenant_a, "users": users}


def test_webhook_crud_is_admin_only_and_workspace_scoped(api, team, tenant_b, monkeypatch):
    member = api(team["users"][Membership.Role.MEMBER], team["workspace"])
    assert member.get("/api/webhooks/").status_code == 403
    owner = api(team["owner"], team["workspace"])
    response = owner.post("/api/webhooks/", {
        "name": "Issue receiver", "url": "https://hooks.example.test/flowboard",
        "events": ["issue.created", "issue.updated"],
    }, format="json")
    assert response.status_code == 201, response.data
    endpoint = WebhookEndpoint.objects.get(pk=response.data["id"])
    assert len(response.data["secret"]) == 64
    assert member.patch(f"/api/webhooks/{endpoint.pk}/", {"name": "no"}, format="json").status_code == 403
    assert api(tenant_b["owner"], tenant_b["workspace"]).get(f"/api/webhooks/{endpoint.pk}/").status_code == 404
    monkeypatch.setattr("apps.automation.views.deliver_webhook.delay", MagicMock())
    queued = owner.post(f"/api/webhooks/{endpoint.pk}/test/", {}, format="json")
    assert queued.status_code == 202
    assert queued.data["event"] == "webhook.test"
    assert owner.post(f"/api/webhooks/{endpoint.pk}/rotate-secret/", {}, format="json").data["secret"] != endpoint.secret


def test_webhook_rejects_insecure_and_unsupported_targets(api, team):
    client = api(team["owner"], team["workspace"])
    assert client.post("/api/webhooks/", {"name": "bad", "url": "ftp://example.test/a", "events": []}, format="json").status_code == 400
    assert client.post("/api/webhooks/", {"name": "bad", "url": "https://user:pass@example.test/a", "events": []}, format="json").status_code == 400
    assert client.post("/api/webhooks/", {"name": "bad", "url": "https://example.test/a", "events": ["unknown"]}, format="json").status_code == 400


def test_delivery_hmac_success_and_workspace_state(api, team, monkeypatch):
    endpoint = WebhookEndpoint.objects.create(workspace=team["workspace"], created_by=team["owner"], name="hook", url="https://hooks.example.test", events=["issue.created"])
    delivery = WebhookDelivery.objects.create(workspace=team["workspace"], endpoint=endpoint, event_id=uuid.uuid4(), event="issue.created", payload={"issue": {"key": "WEB-1"}})
    monkeypatch.setattr("apps.automation.tasks._safe_target", lambda _url: None)
    response = MagicMock(status=204)
    response.read.return_value = b"ok"
    response.__enter__.return_value = response
    monkeypatch.setattr("apps.automation.tasks.urllib.request.build_opener", lambda *_args: MagicMock(open=MagicMock(return_value=response)))
    result = deliver_webhook.apply(args=(delivery.pk,), throw=True)
    delivery.refresh_from_db()
    assert result.successful()
    assert delivery.state == WebhookDelivery.State.DELIVERED
    assert delivery.attempts == 1 and delivery.response_status == 204


def test_issue_event_creates_signed_delivery_and_member_notification(api, team, monkeypatch):
    issue = Issue.objects.create(project=team["project"], title="Task", assignee=team["users"][Membership.Role.MEMBER])
    endpoint = WebhookEndpoint.objects.create(workspace=team["workspace"], created_by=team["owner"], name="hook", url="https://hooks.example.test", events=["issue.created"])
    audit = AuditLog.objects.create(workspace=team["workspace"], project=team["project"], issue_key=issue.key,
        issue_title=issue.title, actor=team["owner"], action=AuditLog.Action.CREATED, changes={})
    delivery_task = MagicMock()
    monkeypatch.setattr("apps.automation.tasks.deliver_webhook.delay", delivery_task)
    process_issue_event.apply(args=(audit.pk,), throw=True)
    delivery = WebhookDelivery.objects.get(endpoint=endpoint)
    assert delivery.event == "issue.created" and delivery.payload["issue"]["key"] == issue.key
    notification = Notification.objects.get(recipient=issue.assignee)
    assert notification.workspace_id == team["workspace"].pk
    assert notification.url.endswith(f"issue={issue.key}")
    delivery_task.assert_called_once_with(delivery.pk)


def test_comment_mentions_generate_private_notification(api, team, monkeypatch):
    issue = Issue.objects.create(project=team["project"], title="Mentioned")
    member = team["users"][Membership.Role.MEMBER]
    owner_client = api(team["owner"], team["workspace"])
    response = owner_client.post(f"/api/issues/{issue.key}/comments/", {"body": f"Please check @{member.email}"}, format="json")
    assert response.status_code == 201
    audit = AuditLog.objects.get(issue_key=issue.key, action=AuditLog.Action.COMMENTED)
    process_issue_event.apply(args=(audit.pk,), throw=True)
    assert Notification.objects.filter(recipient=member, workspace=team["workspace"]).exists()
    member_client = api(member, team["workspace"])
    notifications = member_client.get("/api/notifications/")
    assert notifications.status_code == 200 and notifications.data["unread_count"] == 1
    item_id = notifications.data["results"][0]["id"]
    assert member_client.post(f"/api/notifications/{item_id}/read/").status_code == 200
    assert member_client.get("/api/notifications/").data["unread_count"] == 0


def test_report_request_is_async_and_report_generation_is_tenant_scoped(api, team, monkeypatch):
    delay = MagicMock()
    monkeypatch.setattr("apps.automation.views.generate_workspace_report.delay", delay)
    client = api(team["users"][Membership.Role.MEMBER], team["workspace"])
    response = client.post("/api/reports/", {}, format="json")
    assert response.status_code == 202 and response.data["state"] == "pending"
    delay.assert_called_once_with(response.data["id"])
    generate_workspace_report.apply(args=(response.data["id"],), throw=True)
    report = WorkspaceReport.objects.get(pk=response.data["id"])
    assert report.state == WorkspaceReport.State.READY and "issue_count" in report.data
    assert client.get("/api/reports/").data[0]["state"] == "ready"
