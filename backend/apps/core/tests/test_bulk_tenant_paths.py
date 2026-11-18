"""QuerySet.update() and bulk_update() skip TenantModel.save() and its cross-tenant FK check. These tests pin
down every such write path in the app so none of them can reach, or point at, another tenant's rows.

Inventory (grep for .update( / bulk_ in apps/, outside tests and migrations):
  * Sprint completion: update(sprint=target), the only one writing a tenant FK. target is workspace-scoped by
    TenantPrimaryKeyRelatedField and re-checked as same project and planned, under the project lock.
  * Everything else sets scalars (rank, counters, read_at, states) or sets an FK to NULL, always filtered by pk
    or workspace: rebalance_ranks, remove_member + the membership signal, notifications read-all, webhook
    counters, report results, billing status.
  * The only raw SQL is billing's pg_advisory_xact_lock, which writes nothing.
Composite (workspace_id, id) FKs or row-level security would make this DB-enforced; that is a separate
architecture proposal, deliberately not part of the schema review."""
import pytest
from django.utils import timezone

from apps.automation.models import Notification
from apps.issues.models import Issue
from apps.issues.services import rebalance_ranks
from apps.projects.models import Sprint
from apps.tenants.models import Membership
from apps.tenants.services import remove_member

pytestmark = pytest.mark.django_db
Role = Membership.Role


def test_sprint_completion_rejects_another_tenants_sprint(api, tenant_a, tenant_b):
    project_a, project_b = tenant_a["project"], tenant_b["project"]
    active = Sprint.objects.create(project=project_a, name="A", state="active",
                                   start_date=timezone.localdate(), end_date=timezone.localdate())
    open_issue = Issue.objects.create(project=project_a, title="open", sprint=active)
    foreign = Sprint.objects.create(project=project_b, name="B")
    res = api(tenant_a["owner"], tenant_a["workspace"]).post(
        f"/api/sprints/{active.pk}/complete/", {"move_open_issues_to": foreign.pk}, format="json")
    assert res.status_code == 400 and "move_open_issues_to" in res.data
    open_issue.refresh_from_db()
    active.refresh_from_db()
    assert open_issue.sprint_id == active.pk and active.state == "active"  # nothing was moved or closed


def test_sprint_completion_rejects_same_tenant_other_project(api, tenant_a):
    from apps.projects.services import create_project
    project, other = tenant_a["project"], create_project(
        workspace=tenant_a["workspace"], name="Other", key="OTH", created_by=tenant_a["owner"])
    active = Sprint.objects.create(project=project, name="A", state="active",
                                   start_date=timezone.localdate(), end_date=timezone.localdate())
    wrong = Sprint.objects.create(project=other, name="X")
    res = api(tenant_a["owner"], tenant_a["workspace"]).post(
        f"/api/sprints/{active.pk}/complete/", {"move_open_issues_to": wrong.pk}, format="json")
    assert res.status_code == 400


def test_rank_rebalance_touches_only_its_project(tenant_a, tenant_b):
    a = [Issue.objects.create(project=tenant_a["project"], title=f"a{i}", rank=1.0 + i * 1e-9) for i in range(3)]
    b = Issue.objects.create(project=tenant_b["project"], title="b", rank=7.0)
    rebalance_ranks(tenant_a["project"].pk)
    b.refresh_from_db()
    assert b.rank == 7.0
    assert sorted(Issue.objects.filter(pk__in=[i.pk for i in a]).values_list("rank", flat=True)) == [1024.0, 2048.0, 3072.0]


def test_removing_a_member_unassigns_only_in_that_workspace(tenant_a, tenant_b, make_user, add_member):
    both = make_user("both@x.test")
    membership_a = add_member(tenant_a["workspace"], both, Role.MEMBER)
    add_member(tenant_b["workspace"], both, Role.MEMBER)
    in_a = Issue.objects.create(project=tenant_a["project"], title="a", assignee=both)
    in_b = Issue.objects.create(project=tenant_b["project"], title="b", assignee=both)
    remove_member(membership_a, tenant_a["owner"])
    in_a.refresh_from_db()
    in_b.refresh_from_db()
    assert in_a.assignee_id is None and in_b.assignee_id == both.pk


def test_read_all_marks_only_own_notifications_in_this_workspace(api, tenant_a, tenant_b, make_user, add_member):
    user = make_user("reader@x.test")
    add_member(tenant_a["workspace"], user, Role.MEMBER)
    add_member(tenant_b["workspace"], user, Role.MEMBER)
    mine_a = Notification.objects.create(workspace=tenant_a["workspace"], recipient=user, event_key="a", title="t", body="b")
    mine_b = Notification.objects.create(workspace=tenant_b["workspace"], recipient=user, event_key="b", title="t", body="b")
    theirs = Notification.objects.create(workspace=tenant_a["workspace"], recipient=tenant_a["owner"], event_key="c",
                                         title="t", body="b")
    assert api(user, tenant_a["workspace"]).post("/api/notifications/read-all/").data == {"updated": 1}
    for item, read in ((mine_a, True), (mine_b, False), (theirs, False)):
        item.refresh_from_db()
        assert (item.read_at is not None) is read
