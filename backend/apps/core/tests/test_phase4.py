import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.issues.models import Issue, IssueAttachment, IssueAuditLog, IssueComment
from apps.projects.models import WorkflowStatus
from apps.tenants.models import Membership

pytestmark = pytest.mark.django_db


@pytest.fixture
def team(tenant_a, make_user, add_member):
    workspace = tenant_a["workspace"]
    users = {"owner": tenant_a["owner"]}
    for role in (Membership.Role.ADMIN, Membership.Role.MEMBER, Membership.Role.VIEWER):
        user = make_user(f"{role}@phase4.test")
        add_member(workspace, user, role)
        users[role] = user
    return {**tenant_a, "users": users}


def test_workflow_editor_reorders_statuses_and_enforces_transitions(api, team):
    project = team["project"]
    todo, progress, review, done = project.workflow.statuses.order_by("position")
    member_client = api(team["users"][Membership.Role.MEMBER], team["workspace"])
    assert member_client.get("/api/projects/WEB/workflow/").status_code == 200
    payload = {
        "name": "Engineering workflow",
        "enforce_transitions": True,
        "statuses": [
            {"id": todo.id, "name": "Ready", "category": "todo", "color": "#64748b"},
            {"id": progress.id, "name": "Building", "category": "in_progress", "color": "#3b82f6"},
            {"id": done.id, "name": "Shipped", "category": "done", "color": "#22c55e"},
        ],
        "transitions": [{"from": 0, "to": 1}, {"from": 1, "to": 2}],
    }
    res = api(team["owner"], team["workspace"]).put("/api/projects/WEB/workflow/", payload, format="json")
    assert res.status_code == 200, res.data
    assert [status["name"] for status in res.data["statuses"]] == ["Ready", "Building", "Shipped"]
    assert res.data["transitions"] == [{"from": 0, "to": 1}, {"from": 1, "to": 2}]
    assert not project.workflow.statuses.filter(pk=review.pk).exists()
    issue = Issue.objects.create(project=project, title="API task")
    client = api(team["owner"], team["workspace"])
    assert client.patch(f"/api/issues/{issue.key}/", {"status": done.id}, format="json").status_code == 400
    assert client.patch(f"/api/issues/{issue.key}/", {"status": progress.id}, format="json").status_code == 200


def test_workflow_cannot_remove_status_in_use_and_is_admin_write(api, team):
    project = team["project"]
    issue = Issue.objects.create(project=project, title="Uses status")
    get = api(team["users"][Membership.Role.VIEWER], team["workspace"]).get("/api/projects/WEB/workflow/")
    assert get.status_code == 200
    assert api(team["users"][Membership.Role.MEMBER], team["workspace"]).put(
        "/api/projects/WEB/workflow/", get.data, format="json"
    ).status_code == 403
    statuses = list(get.data["statuses"])
    statuses = [item for item in statuses if item["id"] != issue.status_id]
    res = api(team["owner"], team["workspace"]).put(
        "/api/projects/WEB/workflow/",
        {**get.data, "statuses": statuses, "transitions": []},
        format="json",
    )
    assert res.status_code == 400


def test_comments_mentions_activity_and_workspace_isolation(api, team, tenant_b):
    issue = Issue.objects.create(project=team["project"], title="Commented issue")
    member = team["users"][Membership.Role.MEMBER]
    client = api(member, team["workspace"])
    res = client.post(f"/api/issues/{issue.key}/comments/", {"body": "Please review @owner@a.test"}, format="json")
    assert res.status_code == 201, res.data
    assert [mention["email"] for mention in res.data["mentions"]] == ["owner@a.test"]
    assert len(client.get(f"/api/issues/{issue.key}/comments/").data) == 1
    assert [event["action"] for event in client.get(f"/api/issues/{issue.key}/activity/").data] == ["commented"]
    other_issue = Issue.objects.create(project=tenant_b["project"], title="Foreign")
    IssueComment.objects.create(workspace=tenant_b["workspace"], issue=other_issue,
                                 author=tenant_b["owner"], body="Tenant B secret")
    assert client.get(f"/api/issues/{issue.key}/comments/").data[0]["body"] == "Please review @owner@a.test"


def test_comment_author_or_admin_can_edit_and_delete(api, team):
    issue = Issue.objects.create(project=team["project"], title="Comments")
    member = team["users"][Membership.Role.MEMBER]
    response = api(member, team["workspace"]).post(
        f"/api/issues/{issue.key}/comments/", {"body": "Original"}, format="json"
    )
    comment_id = response.data["id"]
    assert api(team["users"][Membership.Role.ADMIN], team["workspace"]).patch(
        f"/api/issues/{issue.key}/comments/{comment_id}/", {"body": "Edited"}, format="json"
    ).status_code == 200
    assert api(member, team["workspace"]).patch(
        f"/api/issues/{issue.key}/comments/{comment_id}/", {"body": "Edited"}, format="json"
    ).data["body"] == "Edited"
    assert api(member, team["workspace"]).delete(f"/api/issues/{issue.key}/comments/{comment_id}/").status_code == 204


def test_attachment_upload_download_delete_and_validation(api, team, tenant_b, settings):
    settings.MEDIA_ROOT = settings.BASE_DIR / ".test-media"
    issue = Issue.objects.create(project=team["project"], title="With file")
    client = api(team["users"][Membership.Role.MEMBER], team["workspace"])
    res = client.post(
        f"/api/issues/{issue.key}/attachments/",
        {"file": SimpleUploadedFile("notes.txt", b"hello", content_type="text/plain")},
        format="multipart",
    )
    assert res.status_code == 201, res.data
    attachment = IssueAttachment.objects.get(pk=res.data["id"])
    download = client.get(f"/api/attachments/{attachment.pk}/download/")
    assert download.status_code == 200
    assert b"".join(download.streaming_content) == b"hello"
    assert download["X-Content-Type-Options"] == "nosniff"
    assert len(client.get(f"/api/issues/{issue.key}/attachments/").data) == 1
    foreign = Issue.objects.create(project=tenant_b["project"], title="Foreign")
    foreign_attachment = IssueAttachment.objects.create(
        workspace=tenant_b["workspace"], issue=foreign, uploaded_by=tenant_b["owner"],
        file=SimpleUploadedFile("secret.txt", b"tenant b", content_type="text/plain"),
        original_name="secret.txt", content_type="text/plain", size=8,
    )
    assert client.get(f"/api/attachments/{foreign_attachment.pk}/download/").status_code == 404
    bad = client.post(
        f"/api/issues/{issue.key}/attachments/",
        {"file": SimpleUploadedFile("run.html", b"<script>", content_type="text/html")},
        format="multipart",
    )
    assert bad.status_code == 400
    other = api(team["users"][Membership.Role.MEMBER], team["workspace"])
    assert other.delete(f"/api/attachments/{attachment.pk}/").status_code == 204
    foreign_attachment.file.delete(save=False)


def test_issue_changes_and_attachment_events_are_audited(api, team, settings):
    settings.MEDIA_ROOT = settings.BASE_DIR / ".test-media"
    client = api(team["owner"], team["workspace"])
    issue = Issue.objects.create(project=team["project"], title="Before")
    assert client.patch(f"/api/issues/{issue.key}/", {"title": "After"}, format="json").status_code == 200
    assert IssueAuditLog.objects.filter(issue_key=issue.key, action=IssueAuditLog.Action.UPDATED,
                                        changes__title__from="Before", changes__title__to="After").exists()


def test_api_issue_creation_is_audited(api, team):
    response = api(team["owner"], team["workspace"]).post(
        "/api/issues/", {"project": team["project"].id, "title": "Audit me"}, format="json"
    )
    assert response.status_code == 201
    assert IssueAuditLog.objects.filter(issue_key=response.data["key"], action=IssueAuditLog.Action.CREATED).exists()

