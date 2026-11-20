"""Schema review, table #5 (issues_issue): no lost updates, description cap, one-query label validation,
assignee membership checked only when written.

The race tests are deterministic: they wrap lock_project so that another transaction commits a change *after*
the request loaded the issue but *before* it takes the lock, which is exactly when a full-row save lost data."""
import threading
from unittest.mock import patch

import pytest
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext

from apps.issues.models import Issue, Label
from apps.projects.models import WorkflowStatus, WorkflowTransition
from apps.projects.services import lock_project as real_lock_project
from apps.tenants.models import Membership

pytestmark = pytest.mark.django_db
Role = Membership.Role


def statuses(project):
    return list(project.workflow.statuses.order_by("position"))  # To Do, In Progress, In Review, Done


def sneak_in(target, **changes):
    """lock_project wrapper: the first time it runs, someone else's committed write lands first."""
    state = {"done": False}

    def wrapper(pk, **kwargs):
        if not state["done"]:
            state["done"] = True
            Issue.objects.filter(pk=target.pk).update(**changes)
        return real_lock_project(pk, **kwargs)

    return wrapper


@pytest.fixture
def setup(api, tenant_a):
    project = tenant_a["project"]
    issue = Issue.objects.create(project=project, title="original", priority=3, reporter=tenant_a["owner"])
    return {**tenant_a, "issue": issue, "client": api(tenant_a["owner"], tenant_a["workspace"]),
            "statuses": statuses(project)}


# --------------------------------------------------------------------------- 1. lost updates

class TestNoLostUpdates:
    def test_different_fields_both_survive(self, setup):
        issue = setup["issue"]
        with patch("apps.issues.views.lock_project", side_effect=sneak_in(issue, priority=5)):
            res = setup["client"].patch(f"/api/issues/{issue.key}/", {"title": "A's title"}, format="json")
        assert res.status_code == 200
        issue.refresh_from_db()
        assert (issue.title, issue.priority) == ("A's title", 5)  # before the fix: ('A's title', 3)

    def test_same_field_last_committed_write_wins(self, setup):
        issue = setup["issue"]
        with patch("apps.issues.views.lock_project", side_effect=sneak_in(issue, title="B's title")):
            setup["client"].patch(f"/api/issues/{issue.key}/", {"title": "A's title"}, format="json")
        issue.refresh_from_db()
        assert issue.title == "A's title"  # rule: edits are serialised by the project lock; the later one wins

    def test_resolved_at_not_reverted_by_a_stale_edit(self, setup):
        issue, done = setup["issue"], setup["statuses"][3]
        from django.utils import timezone
        resolved = timezone.now()
        with patch("apps.issues.views.lock_project", side_effect=sneak_in(issue, status=done, resolved_at=resolved)):
            setup["client"].patch(f"/api/issues/{issue.key}/", {"title": "edited"}, format="json")
        issue.refresh_from_db()
        assert issue.status_id == done.pk and issue.resolved_at == resolved and issue.title == "edited"

    def test_status_and_resolved_at_stay_consistent(self, setup):
        issue, todo, done = setup["issue"], setup["statuses"][0], setup["statuses"][3]
        client = setup["client"]
        client.patch(f"/api/issues/{issue.key}/", {"status": done.pk}, format="json")
        issue.refresh_from_db()
        assert issue.resolved_at is not None
        client.patch(f"/api/issues/{issue.key}/", {"status": todo.pk}, format="json")
        issue.refresh_from_db()
        assert issue.resolved_at is None

    def test_transition_is_checked_against_the_current_status(self, setup):
        issue, todo, in_progress, review = setup["issue"], *setup["statuses"][:3]
        workflow = setup["project"].workflow
        workflow.enforce_transitions = True
        workflow.save()
        WorkflowTransition.objects.create(workflow=workflow, from_status=todo, to_status=in_progress)
        # The client saw "To Do" (To Do → In Progress is allowed), but someone moved it to In Review meanwhile.
        with patch("apps.issues.views.lock_project", side_effect=sneak_in(issue, status=review)):
            res = setup["client"].patch(f"/api/issues/{issue.key}/", {"status": in_progress.pk}, format="json")
        assert res.status_code == 400 and "In Review" in str(res.data["status"])

    def test_patch_writes_only_the_sent_columns(self, setup):
        issue = setup["issue"]
        with CaptureQueriesContext(connection) as queries:
            setup["client"].patch(f"/api/issues/{issue.key}/", {"title": "t2"}, format="json")
        update = next(q["sql"] for q in queries.captured_queries if q["sql"].startswith('UPDATE "issues_issue"'))
        assert '"title" =' in update and '"updated_at" =' in update
        for column in ('"description"', '"priority"', '"assignee_id"', '"status_id"', '"created_at"'):
            assert column not in update, update

    def test_move_does_not_revert_a_concurrent_edit_and_audits_real_from(self, setup):
        issue, in_progress = setup["issue"], setup["statuses"][1]
        review = setup["statuses"][2]
        with patch("apps.issues.services.lock_project",
                   side_effect=sneak_in(issue, title="renamed meanwhile", status=review)):
            res = setup["client"].post(f"/api/issues/{issue.key}/move/", {"status": in_progress.pk}, format="json")
        assert res.status_code == 200
        issue.refresh_from_db()
        assert issue.title == "renamed meanwhile" and issue.status_id == in_progress.pk
        from apps.issues.models import AuditLog
        moved = AuditLog.objects.filter(issue_key=issue.key, action="moved").latest("created_at")
        assert moved.changes["status"] == {"from": "In Review", "to": "In Progress"}


@pytest.mark.django_db(transaction=True)
def test_real_threads_editing_different_fields(api, tenant_a):
    issue = Issue.objects.create(project=tenant_a["project"], title="t", priority=3)
    barrier = threading.Barrier(2)

    def edit(body):
        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(tenant_a["owner"])
        client.credentials(HTTP_X_WORKSPACE=tenant_a["workspace"].slug)
        barrier.wait()
        client.patch(f"/api/issues/{issue.key}/", body, format="json")
        connection.close()

    threads = [threading.Thread(target=edit, args=(b,)) for b in ({"title": "new title"}, {"priority": 5})]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    issue.refresh_from_db()
    assert (issue.title, issue.priority) == ("new title", 5)


# --------------------------------------------------------------------------- 2. description cap

class TestDescriptionCap:
    def test_limit_and_message(self, setup):
        issue, client = setup["issue"], setup["client"]
        ok = client.patch(f"/api/issues/{issue.key}/", {"description": "x" * 50_000}, format="json")
        assert ok.status_code == 200
        too_long = client.patch(f"/api/issues/{issue.key}/", {"description": "x" * 50_001}, format="json")
        assert too_long.status_code == 400
        assert too_long.data["description"] == ["Description can be at most 50,000 characters."]

    def test_whitespace_kept(self, setup):
        issue = setup["issue"]
        body = "  - item\n\n    code block\n"
        setup["client"].patch(f"/api/issues/{issue.key}/", {"description": body}, format="json")
        issue.refresh_from_db()
        assert issue.description == body

    def test_db_rejects_bypassing_writes(self, setup):
        with pytest.raises(IntegrityError), transaction.atomic():
            Issue.objects.filter(pk=setup["issue"].pk).update(description="x" * 50_001)


# --------------------------------------------------------------------------- 3. labels in one query

class TestBulkLabels:
    def label_selects(self, client, issue, ids):
        with CaptureQueriesContext(connection) as queries:
            res = client.patch(f"/api/issues/{issue.key}/", {"labels": ids}, format="json")
        selects = [q for q in queries.captured_queries
                   if q["sql"].startswith('SELECT "issues_label"."id", "issues_label"."created_at"')]
        return res, len(selects)

    def test_query_count_does_not_grow_with_labels(self, setup):
        labels = [Label.objects.create(workspace=setup["workspace"], name=f"l{i}") for i in range(10)]
        _, one = self.label_selects(setup["client"], setup["issue"], [labels[0].pk])
        res, ten = self.label_selects(setup["client"], setup["issue"], [l.pk for l in labels])
        assert res.status_code == 200 and len(res.data["labels"]) == 10
        assert one == ten

    @pytest.mark.parametrize("bad, message", [
        ("foreign", 'Invalid pk "{pk}" - object does not exist.'),
        ("abc", "Incorrect type. Expected pk value, received str."),
        (True, "Incorrect type. Expected pk value, received bool."),
        (99999999999999999999999, 'Invalid pk "99999999999999999999999" - object does not exist.'),
    ])
    def test_errors_match_drf(self, setup, tenant_b, bad, message):
        mine = Label.objects.create(workspace=setup["workspace"], name="mine")
        if bad == "foreign":
            bad = Label.objects.create(workspace=tenant_b["workspace"], name="theirs").pk
        res = setup["client"].patch(f"/api/issues/{setup['issue'].key}/", {"labels": [mine.pk, bad]}, format="json")
        assert res.status_code == 400 and res.data["labels"] == [message.format(pk=bad)]

    def test_duplicates_and_empty(self, setup):
        label = Label.objects.create(workspace=setup["workspace"], name="dup")
        client, issue = setup["client"], setup["issue"]
        res = client.patch(f"/api/issues/{issue.key}/", {"labels": [label.pk, label.pk]}, format="json")
        assert res.status_code == 200 and res.data["labels"] == [label.pk]
        assert client.patch(f"/api/issues/{issue.key}/", {"labels": []}, format="json").data["labels"] == []


# --------------------------------------------------------------------- 4. assignee checks

class TestAssigneeCheck:
    def membership_checks(self, client, issue, body, user_id):
        """EXISTS checks for this user's membership. (The audit row runs its own check for the *actor*, the
        editor, which is a separate rule; counting only the assignee's id keeps it out of the number.)"""
        with CaptureQueriesContext(connection) as queries:
            res = client.patch(f"/api/issues/{issue.key}/", body, format="json")
        n = sum(1 for q in queries.captured_queries
                if q["sql"].startswith('SELECT 1 AS "a" FROM "tenants_membership"')
                and f'"user_id" = {user_id}' in q["sql"])
        return res, n

    def test_title_only_patch_skips_it(self, setup, make_user, add_member):
        dev = make_user("dev@x.test")
        add_member(setup["workspace"], dev, Role.MEMBER)
        Issue.objects.filter(pk=setup["issue"].pk).update(assignee=dev)
        res, checks = self.membership_checks(setup["client"], setup["issue"], {"title": "only title"}, dev.pk)
        assert res.status_code == 200 and checks == 0

    def test_changed_assignee_is_checked_and_null_allowed(self, setup, make_user, add_member):
        dev = make_user("dev2@x.test")
        add_member(setup["workspace"], dev, Role.MEMBER)
        res, checks = self.membership_checks(setup["client"], setup["issue"], {"assignee": dev.pk}, dev.pk)
        assert res.status_code == 200 and checks == 1
        res, _ = self.membership_checks(setup["client"], setup["issue"], {"assignee": None}, dev.pk)
        assert res.status_code == 200 and res.data["assignee"] is None

    def test_other_workspace_user_never_assignable(self, setup, tenant_b):
        res = setup["client"].patch(f"/api/issues/{setup['issue'].key}/", {"assignee": tenant_b["owner"].pk},
                                    format="json")
        assert res.status_code == 400 and "assignee" in res.data
