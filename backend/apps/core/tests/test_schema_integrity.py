"""Schema review: every new DB constraint rejects bad data even when the app's validation is bypassed
(QuerySet.update() and raw SQL skip model and serializer checks), plus the invariants that go with them."""
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DataError, IntegrityError, connection, transaction

from apps.accounts.models import User
from apps.automation.models import WebhookDelivery, WebhookEndpoint, WorkspaceReport
from apps.billing.models import StripeEvent
from apps.issues.models import AuditLog, Issue, IssueAttachment, Label
from apps.projects.models import Board, Project, Sprint, WorkflowStatus
from apps.tenants.models import Invitation, Membership, Workspace
from apps.tenants.services import create_workspace, transfer_ownership

pytestmark = pytest.mark.django_db
Role = Membership.Role


def rejected(queryset, **values):
    """True if PostgreSQL refuses the update. update() bypasses save() and every Django validator."""
    try:
        with transaction.atomic():
            queryset.update(**values)
    except (IntegrityError, DataError):  # DataError: e.g. too long for varchar(7), also a DB-level refusal
        return True
    return False


@pytest.fixture
def world(tenant_a, make_user):
    project = tenant_a["project"]
    issue = Issue.objects.create(project=project, title="t")
    return {**tenant_a, "issue": issue, "status": project.workflow.statuses.first(),
            "board": Board.objects.get(project=project)}


# ------------------------------------------------------------------- 1. choice columns

@pytest.mark.parametrize("model, field, bad", [
    (Workspace, "plan", "platinum"),
    (Membership, "role", "superadmin"),
    (WorkflowStatus, "category", "blocked"),
    (Board, "board_type", "gantt"),
    (Sprint, "state", "paused"),
    (Issue, "issue_type", "story-ish"),
    (AuditLog, "action", "hacked"),
    (AuditLog, "entity_type", "secret"),
])
def test_choice_columns_reject_unknown_values(world, model, field, bad):
    if model is Sprint:
        Sprint.objects.create(project=world["project"], name="S")
    if model is AuditLog:
        AuditLog.objects.create(workspace=world["workspace"], action="created", entity_type="issue")
    assert rejected(model.objects.all(), **{field: bad})


def test_invitation_role_can_never_be_owner(world):
    invite = Invitation.objects.create(workspace=world["workspace"], email="x@a.test")
    assert rejected(Invitation.objects.filter(pk=invite.pk), role="owner")
    assert not rejected(Invitation.objects.filter(pk=invite.pk), role="admin")


@pytest.mark.parametrize("priority, ok", [(1, True), (5, True), (0, False), (6, False)])
def test_priority_is_1_to_5(world, priority, ok):
    assert rejected(Issue.objects.filter(pk=world["issue"].pk), priority=priority) is not ok


@pytest.mark.parametrize("points, ok", [(None, True), (0, True), (100, True), (101, False)])
def test_story_points_cap(world, points, ok):
    assert rejected(Issue.objects.filter(pk=world["issue"].pk), story_points=points) is not ok


@pytest.mark.parametrize("rank", [float("nan"), float("inf"), float("-inf")])
def test_rank_must_be_finite(world, rank):
    assert rejected(Issue.objects.filter(pk=world["issue"].pk), rank=rank)


def test_delivery_and_report_states(world):
    endpoint = WebhookEndpoint.objects.create(workspace=world["workspace"], name="h", url="https://h.test/x")
    import uuid
    WebhookDelivery.objects.create(workspace=world["workspace"], endpoint=endpoint, event_id=uuid.uuid4(),
                                   event="e", payload={})
    report = WorkspaceReport.objects.create(workspace=world["workspace"])
    assert rejected(WebhookDelivery.objects.all(), state="lost")
    assert rejected(WorkspaceReport.objects.filter(pk=report.pk), state="running")
    assert rejected(WorkspaceReport.objects.filter(pk=report.pk), report_type="gantt")


# ---------------------------------------------------------------------- 2. one owner

def test_only_one_owner_membership_per_workspace(world, make_user, add_member):
    other = make_user("second@a.test")
    membership = add_member(world["workspace"], other, Role.ADMIN)
    assert rejected(Membership.objects.filter(pk=membership.pk), role="owner")


def test_owner_id_and_owner_membership_stay_in_sync(world, make_user, add_member):
    def in_sync(ws):
        ws.refresh_from_db()
        owners = list(Membership.objects.filter(workspace=ws, role=Role.OWNER).values_list("user_id", flat=True))
        return owners == [ws.owner_id]

    ws = world["workspace"]
    assert in_sync(ws)
    target = add_member(ws, make_user("heir@a.test"), Role.MEMBER)
    transfer_ownership(ws, world["owner"], target.pk)
    assert in_sync(ws)
    fresh = create_workspace(name="Fresh", owner=make_user("founder@a.test"))
    assert in_sync(fresh)


# ------------------------------------------------------------------------ 3. emails

def test_email_lowercased_on_every_save_and_enforced_by_db(make_user):
    user = User(email="  Mixed.Case@Example.TEST ")
    user.set_password("x")
    user.save()  # the admin form path: no UserManager involved
    assert User.objects.get(pk=user.pk).email == "mixed.case@example.test"
    assert rejected(User.objects.filter(pk=user.pk), email="Mixed.Case@Example.TEST")


def test_case_variant_duplicate_is_impossible(make_user):
    make_user("dup@a.test")
    with pytest.raises(IntegrityError), transaction.atomic():
        u = User(email="DUP@A.TEST")
        u.set_password("x")
        u.save()


# ----------------------------------------------------------------------- 4. colours

@pytest.mark.parametrize("bad", ["red", "#fff", "#12345g", "#1234567", "<x>"])
def test_colours_must_be_hex(world, make_user, bad):
    label = Label.objects.create(workspace=world["workspace"], name="l")
    user = make_user()
    assert rejected(Project.objects.filter(pk=world["project"].pk), color=bad)
    assert rejected(Label.objects.filter(pk=label.pk), color=bad)
    assert rejected(WorkflowStatus.objects.filter(pk=world["status"].pk), color=bad)
    assert rejected(User.objects.filter(pk=user.pk), avatar_color=bad)


# ------------------------------------------------------------------ 5. active sprint

def test_active_sprint_needs_both_dates(world):
    from datetime import date
    sprint = Sprint.objects.create(project=world["project"], name="S")
    qs = Sprint.objects.filter(pk=sprint.pk)
    assert rejected(qs, state="active")  # no dates
    assert rejected(qs, state="active", start_date=date(2026, 11, 1))  # only one
    assert not rejected(qs, state="active", start_date=date(2026, 11, 1), end_date=date(2026, 11, 14))
    assert rejected(qs, end_date=None)  # can't drop a date while active


def test_starting_through_the_api_fills_dates(api, world):
    sprint = Sprint.objects.create(project=world["project"], name="S")
    res = api(world["owner"], world["workspace"]).post(f"/api/sprints/{sprint.pk}/start/", {}, format="json")
    assert res.status_code == 200 and res.data["start_date"] and res.data["end_date"]


# -------------------------------------------------------------- 9. one board per project

def test_second_board_for_a_project_is_rejected(world):
    with pytest.raises(IntegrityError), transaction.atomic():
        Board.objects.create(project=world["project"], name="Second")


# ---------------------------------------------------------- 10. attachment storage path

def test_attachment_path_is_short_uuid_and_keeps_original_name(world, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    long_name = "q4-" + "really-long-descriptive-name-" * 8 + "final.pdf"
    attachment = IssueAttachment.objects.create(
        workspace=world["workspace"], issue=world["issue"], uploaded_by=world["owner"], original_name=long_name,
        content_type="application/pdf", size=8, file=SimpleUploadedFile(long_name, b"%PDF-1.7"),
    )
    parts = attachment.file.name.split("/")
    assert parts[0] == "issues" and len(parts[-1]) == 32 + len(".pdf") and parts[-1].endswith(".pdf")
    assert attachment.original_name == long_name  # full name kept for display
    assert IssueAttachment._meta.get_field("file").max_length == 255


# ---------------------------------------------------------- 11. status positions

def test_duplicate_position_rejected_at_commit_but_swaps_work(world):
    statuses = list(world["project"].workflow.statuses.order_by("position"))
    a, b = statuses[0], statuses[1]
    with connection.cursor() as cur:
        cur.execute("SET CONSTRAINTS uq_status_position_per_workflow IMMEDIATE")  # check now, not at commit
    assert rejected(WorkflowStatus.objects.filter(pk=b.pk), position=a.position)
    with connection.cursor() as cur:
        cur.execute("SET CONSTRAINTS uq_status_position_per_workflow DEFERRED")
    with transaction.atomic():  # a swap passes through a duplicate, which is fine until commit
        WorkflowStatus.objects.filter(pk=a.pk).update(position=b.position)
        WorkflowStatus.objects.filter(pk=b.pk).update(position=statuses[0].position)
        with connection.cursor() as cur:
            cur.execute("SET CONSTRAINTS uq_status_position_per_workflow IMMEDIATE")


def test_workflow_editor_reorder_still_works(api, world):
    client = api(world["owner"], world["workspace"])
    config = client.get(f"/api/projects/{world['project'].key}/workflow/").data
    config["statuses"] = list(reversed(config["statuses"]))
    config["transitions"] = []
    res = client.put(f"/api/projects/{world['project'].key}/workflow/", config, format="json")
    assert res.status_code == 200, res.data
    assert [s["position"] for s in res.data["statuses"]] == [0, 1, 2, 3]


# ------------------------------------------------------------------ 13. StripeEvent

def test_stripe_event_has_only_a_creation_time():
    fields = {f.name for f in StripeEvent._meta.get_fields()}
    assert "created_at" in fields and "updated_at" not in fields
    assert StripeEvent.objects.create(event_id="evt_1", event_type="x").created_at


# ---------------------------------------------------------- 6. redundant indexes gone

def test_redundant_indexes_dropped_and_fk_indexes_kept():
    with connection.cursor() as cur:
        cur.execute("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'")
        defs = [row[0] for row in cur.fetchall()]

    def single(table, column):
        """A plain single-column index (not unique, not partial), i.e. what db_index=True creates."""
        return any(d.startswith("CREATE INDEX") and d.endswith(f"ON public.{table} USING btree ({column})")
                   for d in defs)

    for table in ("issues_issue", "issues_auditlog", "automation_notification", "tenants_membership", "issues_label"):
        assert not single(table, "workspace_id"), table
    assert not single("issues_auditlog", "issue_key") and not single("issues_issue", "rank")
    # still there: composites that cover them, and FK indexes used by ON DELETE lookups
    for table, column in [("issues_issue", "sprint_id"), ("issues_issue", "status_id"), ("issues_issue", "project_id"),
                          ("projects_sprint", "workspace_id"), ("issues_issuecomment", "workspace_id")]:
        assert single(table, column), (table, column)
