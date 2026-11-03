"""Malformed input must produce a 4xx response, never a server error."""
import pytest
from rest_framework.test import APIClient

from apps.issues.models import Issue
from apps.tenants.models import Membership

pytestmark = pytest.mark.django_db

HUGE = "99999999999999999999999"

ANONYMOUS_POSTS = [
    ("/api/auth/login/", ["x"]),
    ("/api/auth/login/", {"email": {"a": 1}, "password": ["x"]}),
    ("/api/auth/register/", ["x"]),
    ("/api/auth/register/", {"email": None, "password": None, "first_name": None}),
    ("/api/auth/register/", {"email": "a@b.test", "password": "S3cure-pass!", "first_name": "A", "invite_token": ["x"]}),
    ("/api/auth/refresh/", ["x"]),
    ("/api/auth/refresh/", {"refresh": 123}),
    ("/api/auth/logout/", ["x"]),
    ("/api/auth/logout/", {"refresh": 123}),
    ("/api/auth/logout/", {"refresh": {"a": 1}}),
]

MEMBER_GETS = [
    "/api/issues/?project=%s" % HUGE, "/api/issues/?sprint=%s" % HUGE, "/api/issues/?assignee=%s" % HUGE,
    "/api/issues/?assignee=abc", "/api/issues/?status=abc", "/api/issues/?priority=abc", "/api/issues/?label=abc",
    "/api/issues/?parent=abc", "/api/issues/?overdue=abc", "/api/issues/?ordering=nope", "/api/issues/?page=abc",
    "/api/issues/?page=999", "/api/issues/?page_size=abc&page=1", "/api/issues/?search=%00",
    "/api/issues/?parent=%s" % HUGE, "/api/issues/?label=%s" % HUGE, "/api/issues/?status=%s" % HUGE,
    "/api/issues/WEB-%s/" % HUGE, "/api/issues/WEB-%s/activity/" % HUGE, "/api/issues/WEB-1/comments/%s/" % HUGE,
    "/api/sprints/?project=%s" % HUGE, "/api/sprints/?state=nope", "/api/sprints/%s/" % HUGE, "/api/sprints/abc/",
    "/api/boards/abc/", "/api/boards/?project=abc", "/api/projects/?is_archived=abc", "/api/projects/nope/",
    "/api/members/?search=%00", "/api/labels/abc/", "/api/attachments/%s/download/" % HUGE,
    "/api/attachments/abc/download/", "/api/webhooks/abc/", "/api/invitations/preview/%00/",
    "/api/reports/abc/", "/api/reports/%s/" % HUGE, "/api/reports/%s/download/" % HUGE,
    "/api/audit-log/?actor=abc", "/api/audit-log/?actor=%s" % HUGE, "/api/audit-log/?date_from=nope",
    "/api/audit-log/?search=%00", "/api/audit-log/?project=%00", "/api/audit-log/?action=%00",
]

MEMBER_WRITES = [
    ("post", "/api/issues/", ["x"]),
    ("post", "/api/issues/", {"project": "abc", "title": "x"}),
    ("post", "/api/issues/", {"project": HUGE, "title": "x"}),
    ("post", "/api/issues/", {"project": {"a": 1}, "title": ["x"]}),
    ("post", "/api/issues/", {"title": "bad\x00null"}),
    ("patch", "/api/issues/WEB-1/", {"story_points": 999999}),
    ("patch", "/api/issues/WEB-1/", {"story_points": -1}),
    ("patch", "/api/issues/WEB-1/", {"priority": 99}),
    ("patch", "/api/issues/WEB-1/", {"due_date": "nope"}),
    ("patch", "/api/issues/WEB-1/", {"labels": "x"}),
    ("patch", "/api/issues/WEB-1/", {"labels": [HUGE]}),
    ("patch", "/api/issues/WEB-1/", {"assignee": HUGE}),
    ("patch", "/api/issues/WEB-1/", {"parent": HUGE}),
    ("post", "/api/issues/WEB-1/move/", ["x"]),
    ("post", "/api/issues/WEB-1/move/", {"prev_id": HUGE, "next_id": HUGE}),
    ("post", "/api/issues/WEB-1/move/", {"status": "abc"}),
    ("post", "/api/issues/WEB-1/comments/", ["x"]),
    ("post", "/api/issues/WEB-1/comments/", {"body": {"a": 1}}),
    ("post", "/api/issues/WEB-1/comments/", {"body": "bad\x00null"}),
    ("post", "/api/issues/WEB-1/attachments/", {}),
    ("post", "/api/sprints/", ["x"]),
    ("post", "/api/sprints/", {"project": "abc"}),
    ("post", "/api/sprints/abc/start/", {}),
    ("post", "/api/sprints/%s/complete/" % HUGE, {}),
    ("post", "/api/invitations/accept/", ["x"]),
    ("post", "/api/invitations/accept/", {"token": {"a": 1}}),
    ("post", "/api/invitations/accept/", {"token": ["x"]}),
    ("post", "/api/invitations/accept/", {"token": "bad\x00null"}),
    ("post", "/api/notifications/%s/read/" % HUGE, {}),
    ("post", "/api/workspaces/", ["x"]),
    ("post", "/api/reports/", ["x"]),
    ("post", "/api/reports/", {"report_type": {"a": 1}}),
    ("post", "/api/reports/", {"report_type": "velocity", "project": "abc"}),
    ("post", "/api/reports/", {"report_type": "sprint_burndown", "sprint": HUGE}),
    ("post", "/api/invitations/abc/resend/", {}),
    ("patch", "/api/auth/me/", {"email_notifications": "maybe"}),
    ("patch", "/api/auth/me/", {"avatar_color": {"a": 1}}),
    ("post", "/api/auth/change-password/", ["x"]),
]

ADMIN_WRITES = [
    ("post", "/api/projects/", ["x"]),
    ("post", "/api/projects/", {"name": "x", "key": {"a": 1}}),
    ("post", "/api/projects/", {"name": "x", "key": "bad key"}),
    ("post", "/api/projects/", {"name": "x", "key": "OK", "lead": HUGE}),
    ("patch", "/api/boards/1/", {"wip_limits": "x"}),
    ("put", "/api/projects/WEB/workflow/", ["x"]),
    ("put", "/api/projects/WEB/workflow/", {"enforce_transitions": True, "statuses": "x"}),
    ("put", "/api/projects/WEB/workflow/", {"enforce_transitions": True, "statuses": [1, 2]}),
    ("put", "/api/projects/WEB/workflow/", {"enforce_transitions": True, "statuses": [{"name": ["a"]}, {"id": {"a": 1}}]}),
    ("put", "/api/projects/WEB/workflow/", {
        "enforce_transitions": True, "transitions": [{"from": [], "to": {}}, 5],
        "statuses": [{"name": "A", "category": "todo", "color": ["x"]}, {"name": "B", "category": ["done"]}],
    }),
    ("post", "/api/webhooks/", ["x"]),
    ("post", "/api/webhooks/", {"name": "x", "url": "https://a.test", "events": [{"a": 1}]}),
    ("post", "/api/webhooks/", {"name": "x", "url": "http://[bad", "events": []}),
    ("post", "/api/webhooks/", {"name": "x", "url": "https://a.test", "events": "x"}),
    ("post", "/api/invitations/", ["x"]),
    ("post", "/api/invitations/", {"email": {"a": 1}}),
    ("patch", "/api/members/abc/", {"role": "admin"}),
    ("patch", "/api/workspace/", ["x"]),
]


def client_for(user=None, workspace=None):
    client = APIClient(raise_request_exception=False)
    if user:
        client.force_authenticate(user)
    if workspace:
        client.credentials(HTTP_X_WORKSPACE=workspace.slug)
    return client


@pytest.fixture
def owner(tenant_a):
    Issue.objects.create(project=tenant_a["project"], title="seed")
    return client_for(tenant_a["owner"], tenant_a["workspace"])


@pytest.mark.parametrize("path,body", ANONYMOUS_POSTS)
def test_anonymous_posts_never_crash(path, body):
    res = client_for().post(path, body, format="json")
    assert res.status_code < 500, (path, body, res.status_code)


@pytest.mark.parametrize("path", MEMBER_GETS)
def test_reads_never_crash(owner, path):
    res = owner.get(path)
    assert res.status_code < 500, (path, res.status_code)


@pytest.mark.parametrize("method,path,body", MEMBER_WRITES + ADMIN_WRITES)
def test_writes_never_crash(owner, method, path, body):
    res = getattr(owner, method)(path, body, format="json")
    assert res.status_code < 500, (method, path, body, res.status_code)


def test_unparseable_json_is_400(owner):
    res = owner.post("/api/issues/", "{not json", content_type="application/json")
    assert res.status_code == 400


def test_bad_workspace_header_never_crashes(tenant_a):
    client = client_for(tenant_a["owner"])
    client.credentials(HTTP_X_WORKSPACE="bad\x00slug")
    assert client.get("/api/projects/").status_code < 500
    assert Membership.objects.filter(user=tenant_a["owner"]).count() == 1
