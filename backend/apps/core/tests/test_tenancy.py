import pytest
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction

from apps.core.context import TenantContextMissing, get_current_workspace, workspace_context
from apps.issues.models import Issue, Label
from apps.projects.models import Project, Sprint, WorkflowStatus
from apps.tenants.models import Membership

pytestmark = pytest.mark.django_db


class TestQueryIsolation:
    def test_for_workspace_only_returns_own_rows(self, tenant_a, tenant_b):
        Issue.objects.create(project=tenant_a["project"], title="A issue")
        Issue.objects.create(project=tenant_b["project"], title="B issue")

        a_titles = list(Issue.objects.for_workspace(tenant_a["workspace"]).values_list("title", flat=True))
        assert a_titles == ["A issue"]

    def test_for_workspace_none_returns_nothing(self, tenant_a):
        Issue.objects.create(project=tenant_a["project"], title="x")
        assert Issue.objects.for_workspace(None).count() == 0

    def test_current_fails_closed_without_context(self, tenant_a):
        with pytest.raises(TenantContextMissing):
            Project.objects.current()

    def test_current_uses_bound_context(self, tenant_a, tenant_b):
        with workspace_context(tenant_b["workspace"]):
            assert list(Project.objects.current()) == [tenant_b["project"]]
        assert get_current_workspace() is None

    def test_same_project_key_allowed_in_different_workspaces(self, tenant_a, tenant_b):
        assert tenant_a["project"].key == tenant_b["project"].key == "WEB"


class TestWriteIsolation:
    def test_workspace_inherited_from_parent(self, tenant_a):
        issue = Issue.objects.create(project=tenant_a["project"], title="x")
        assert issue.workspace_id == tenant_a["workspace"].id

    def test_save_without_workspace_or_context_is_refused(self):
        with pytest.raises(TenantContextMissing):
            Label.objects.create(name="orphan")

    def test_save_uses_bound_context(self, tenant_a):
        with workspace_context(tenant_a["workspace"]):
            label = Label.objects.create(name="frontend")
        assert label.workspace_id == tenant_a["workspace"].id

    def test_cannot_use_status_from_another_tenant(self, tenant_a, tenant_b):
        foreign_status = tenant_b["project"].default_status
        with pytest.raises(ValidationError) as exc:
            Issue.objects.create(project=tenant_a["project"], title="x", status=foreign_status)
        assert "status" in exc.value.message_dict

    def test_cannot_put_issue_in_foreign_sprint(self, tenant_a, tenant_b):
        foreign_sprint = Sprint.objects.create(project=tenant_b["project"], name="B sprint")
        with pytest.raises(ValidationError):
            Issue.objects.create(project=tenant_a["project"], title="x", sprint=foreign_sprint)

    def test_cannot_assign_non_member(self, tenant_a, tenant_b):
        with pytest.raises(ValidationError) as exc:
            Issue.objects.create(project=tenant_a["project"], title="x", assignee=tenant_b["owner"])
        assert "assignee" in exc.value.message_dict

    def test_can_assign_member(self, tenant_a, make_user, add_member):
        dev = make_user()
        add_member(tenant_a["workspace"], dev)
        issue = Issue.objects.create(project=tenant_a["project"], title="x", assignee=dev)
        assert issue.assignee == dev

    def test_cannot_attach_foreign_label(self, tenant_a, tenant_b):
        issue = Issue.objects.create(project=tenant_a["project"], title="x")
        foreign_label = Label.objects.create(workspace=tenant_b["workspace"], name="bug")
        with pytest.raises(ValidationError):
            issue.labels.add(foreign_label)

    def test_failed_save_does_not_burn_issue_number(self, tenant_a, tenant_b):
        with pytest.raises(ValidationError):
            Issue.objects.create(project=tenant_a["project"], title="x", assignee=tenant_b["owner"])
        issue = Issue.objects.create(project=tenant_a["project"], title="y")
        assert issue.key == "WEB-1"


class TestDomainRules:
    def test_issue_keys_increment_per_project(self, tenant_a, tenant_b):
        a1 = Issue.objects.create(project=tenant_a["project"], title="1")
        a2 = Issue.objects.create(project=tenant_a["project"], title="2")
        b1 = Issue.objects.create(project=tenant_b["project"], title="1")
        assert (a1.key, a2.key, b1.key) == ("WEB-1", "WEB-2", "WEB-1")

    def test_new_issue_gets_default_status_and_is_ranked_last(self, tenant_a):
        first = Issue.objects.create(project=tenant_a["project"], title="1")
        second = Issue.objects.create(project=tenant_a["project"], title="2")
        assert first.status.name == "To Do"
        assert second.rank > first.rank

    def test_resolved_at_tracks_done_category(self, tenant_a):
        issue = Issue.objects.create(project=tenant_a["project"], title="x")
        done = tenant_a["project"].workflow.statuses.get(category=WorkflowStatus.Category.DONE)
        issue.status = done
        issue.save()
        assert issue.resolved_at is not None
        issue.status = tenant_a["project"].default_status
        issue.save()
        assert issue.resolved_at is None

    def test_only_one_active_sprint_per_project(self, tenant_a):
        Sprint.objects.create(project=tenant_a["project"], name="S1", state=Sprint.State.ACTIVE, start_date="2026-11-01", end_date="2026-11-14")
        with pytest.raises(IntegrityError), transaction.atomic():
            Sprint.objects.create(project=tenant_a["project"], name="S2", state=Sprint.State.ACTIVE, start_date="2026-11-01", end_date="2026-11-14")

    def test_default_project_scaffolding(self, tenant_a):
        project = tenant_a["project"]
        assert list(project.workflow.statuses.values_list("name", flat=True)) == [
            "To Do", "In Progress", "In Review", "Done",
        ]
        assert project.boards.count() == 1

    def test_workflow_transitions_enforced_only_when_enabled(self, tenant_a):
        workflow = tenant_a["project"].workflow
        todo, in_progress, _, done = workflow.statuses.all()
        assert workflow.can_transition(todo, done)
        workflow.enforce_transitions = True
        workflow.save()
        workflow.transitions.create(from_status=todo, to_status=in_progress)
        assert workflow.can_transition(todo, in_progress)
        assert not workflow.can_transition(todo, done)

    def test_owner_membership_and_role_ladder(self, tenant_a):
        membership = Membership.objects.get(workspace=tenant_a["workspace"], user=tenant_a["owner"])
        assert membership.role == Membership.Role.OWNER
        assert membership.has_role(Membership.Role.ADMIN)
        viewer = Membership(role=Membership.Role.VIEWER)
        assert not viewer.has_role(Membership.Role.MEMBER)
