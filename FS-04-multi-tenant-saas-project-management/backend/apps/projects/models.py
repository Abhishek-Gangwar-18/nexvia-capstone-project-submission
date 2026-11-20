from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import RegexValidator
from django.db import models
from django.db.models import Deferrable, F, Q
from django.db.models.functions import Length, Lower, Trim
from django.db.models.lookups import GreaterThan, LessThanOrEqual

from apps.core.models import TenantModel, choices_check, hex_color_check, workspace_fk_without_index

PROJECT_KEY_VALIDATOR = RegexValidator(
    r"^[A-Z][A-Z0-9]{1,9}$", "Key must be 2-10 uppercase letters/digits, starting with a letter."
)


PROJECT_DESCRIPTION_MAX = 10_000


class Project(TenantModel):
    # unique_project_key_per_workspace starts with workspace_id, so a separate single-column index is redundant.
    workspace = workspace_fk_without_index()
    name = models.CharField(max_length=120)
    key = models.CharField(max_length=10, validators=[PROJECT_KEY_VALIDATOR])
    description = models.TextField(blank=True)
    color = models.CharField(max_length=7, default="#6366f1")
    lead = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="led_projects"
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    issue_counter = models.PositiveIntegerField(default=0, editable=False)
    is_archived = models.BooleanField(default=False)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["workspace", "key"], name="unique_project_key_per_workspace"),
            # Keys are canonical uppercase, so the unique constraint above is effectively case-insensitive:
            # "web" can never be stored next to "WEB".
            models.CheckConstraint(condition=Q(key__regex=r"^[A-Z][A-Z0-9]{1,9}$"), name="project_key_canonical"),
            hex_color_check("color", "ck_project_color_hex"),
            models.CheckConstraint(condition=GreaterThan(Length(Trim("name")), 0), name="ck_project_name_not_blank"),
            models.CheckConstraint(condition=LessThanOrEqual(Length("description"), PROJECT_DESCRIPTION_MAX),
                                   name="ck_project_description_max"),
        ]

    def __str__(self):
        return f"{self.key} · {self.name}"

    def allocate_issue_number(self):
        """Atomically reserve the next issue number. Must run inside a transaction:
        the UPDATE row-lock is held until commit, so concurrent creators serialise here."""
        Project.objects.filter(pk=self.pk).update(issue_counter=F("issue_counter") + 1)
        self.issue_counter = Project.objects.values_list("issue_counter", flat=True).get(pk=self.pk)
        return self.issue_counter

    @property
    def default_status(self):
        return self.workflow.statuses.order_by("position", "id").first()


class Workflow(TenantModel):
    """Each project owns one workflow: an ordered set of statuses plus optional transition rules."""

    project = models.OneToOneField(Project, on_delete=models.CASCADE, related_name="workflow")
    name = models.CharField(max_length=120)
    # When False every status can move to every other status (simple Kanban).
    # When True only the explicit WorkflowTransition rows are allowed (Phase 4 editor).
    enforce_transitions = models.BooleanField(default=False)

    tenant_parent = "project"

    class Meta:
        constraints = [
            models.CheckConstraint(condition=GreaterThan(Length(Trim("name")), 0), name="ck_workflow_name_not_blank"),
            # Target of the transitions' composite FK (workflow_id, workspace_id) (projects migration 0008).
            models.UniqueConstraint(fields=["id", "workspace"], name="uq_workflow_id_workspace"),
        ]

    def __str__(self):
        return self.name

    def can_transition(self, from_status, to_status):
        if from_status is None or from_status.pk == to_status.pk or not self.enforce_transitions:
            return True
        return self.transitions.filter(from_status=from_status, to_status=to_status).exists()



class WorkflowStatusCategory(models.TextChoices):
    TODO = "todo", "To Do"
    IN_PROGRESS = "in_progress", "In Progress"
    DONE = "done", "Done"


# The workflow editor renames kept statuses to "<prefix><workflow>_<index>__" mid-save so names can be swapped
# under the unique index; user names may not start with it (WorkflowConfigSerializer).
RESERVED_STATUS_PREFIX = "__workflow_tmp_"


class WorkflowStatus(TenantModel):
    Category = WorkflowStatusCategory

    # Both unique indexes below start with workflow_id, so a separate single-column index is redundant.
    workflow = models.ForeignKey(Workflow, on_delete=models.CASCADE, related_name="statuses", db_index=False)
    name = models.CharField(max_length=40)
    category = models.CharField(max_length=20, choices=Category.choices, default=Category.TODO)
    color = models.CharField(max_length=7, default="#64748b")
    position = models.PositiveIntegerField(default=0)

    tenant_parent = "workflow"

    class Meta:
        ordering = ["position", "id"]
        verbose_name_plural = "workflow statuses"
        constraints = [
            # Case-insensitive, like the editor's check. Immediate (expression indexes can't be deferred): fine,
            # because the editor's temporary names are distinct.
            models.UniqueConstraint("workflow", Lower("name"), name="uq_status_name_ci_per_workflow"),
            models.CheckConstraint(condition=Q(GreaterThan(Length(Trim("name")), 0)) & Q(name=Trim("name")),
                                   name="ck_status_name_trimmed_not_blank"),
            # Deferred to commit: the workflow editor renumbers statuses one row at a time, so positions
            # can collide mid-transaction even when the final order is valid.
            models.UniqueConstraint(fields=["workflow", "position"], name="uq_status_position_per_workflow",
                                    deferrable=Deferrable.DEFERRED),
            choices_check("category", WorkflowStatusCategory.choices, "ck_status_category"),
            # Target of the transitions' composite FKs (status_id, workflow_id) (projects migration 0008).
            models.UniqueConstraint(fields=["id", "workflow"], name="uq_status_id_workflow"),
            hex_color_check("color", "ck_status_color_hex"),
        ]

    def __str__(self):
        return self.name


class WorkflowTransition(TenantModel):
    workflow = models.ForeignKey(Workflow, on_delete=models.CASCADE, related_name="transitions")
    # unique_transition (from_status, to_status) already indexes from_status first.
    from_status = models.ForeignKey(WorkflowStatus, on_delete=models.CASCADE, related_name="outgoing", db_index=False)
    to_status = models.ForeignKey(WorkflowStatus, on_delete=models.CASCADE, related_name="incoming")
    name = models.CharField(max_length=60, blank=True)

    tenant_parent = "workflow"

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["from_status", "to_status"], name="unique_transition"),
            models.CheckConstraint(condition=~Q(from_status=F("to_status")), name="transition_not_self"),
        ]

    def __str__(self):
        return f"{self.from_status} → {self.to_status}"

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        if self.from_status.workflow_id != self.workflow_id or self.to_status.workflow_id != self.workflow_id:
            raise ValidationError("Transition statuses must belong to the same workflow.")



class BoardTypeChoices(models.TextChoices):
    KANBAN = "kanban", "Kanban"
    SCRUM = "scrum", "Scrum"


class Board(TenantModel):
    BoardType = BoardTypeChoices

    # uq_one_board_per_project is already a unique index on project_id.
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="boards", db_index=False)
    name = models.CharField(max_length=120)
    board_type = models.CharField(max_length=10, choices=BoardType.choices, default=BoardType.SCRUM)
    # {"<status_id>": <max issues>} - columns are the project's workflow statuses.
    wip_limits = models.JSONField(default=dict, blank=True)

    tenant_parent = "project"

    class Meta:
        ordering = ["name"]
        constraints = [
            # The app has always assumed one board per project (it reads the first); now the DB agrees.
            models.UniqueConstraint(fields=["project"], name="uq_one_board_per_project"),
            choices_check("board_type", BoardTypeChoices.choices, "ck_board_type"),
            models.CheckConstraint(condition=GreaterThan(Length(Trim("name")), 0), name="ck_board_name_not_blank"),
            # wip_limits shape (object of whole numbers >= 1) is checked by two raw CHECKs added in
            # projects migration 0009: Django can't express jsonb_typeof / jsonb_path_exists conditions.
        ]

    def __str__(self):
        return self.name



class SprintState(models.TextChoices):
    PLANNED = "planned", "Planned"
    ACTIVE = "active", "Active"
    CLOSED = "closed", "Closed"


SPRINT_GOAL_MAX = 10_000


class Sprint(TenantModel):
    State = SprintState

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="sprints")
    name = models.CharField(max_length=120)
    goal = models.TextField(blank=True)
    state = models.CharField(max_length=10, choices=State.choices, default=State.PLANNED)
    start_date = models.DateField(null=True, blank=True)
    end_date = models.DateField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    tenant_parent = "project"

    class Meta:
        ordering = ["project", "start_date", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["project"], condition=Q(state="active"), name="one_active_sprint_per_project"
            ),
            models.CheckConstraint(
                condition=Q(start_date__isnull=True) | Q(end_date__isnull=True) | Q(end_date__gte=F("start_date")),
                name="sprint_end_after_start",
            ),
            choices_check("state", SprintState.choices, "ck_sprint_state"),
            # Burndown and "days left" need both dates once a sprint is running (start fills them in).
            models.CheckConstraint(
                condition=~Q(state="active") | (Q(start_date__isnull=False) & Q(end_date__isnull=False)),
                name="ck_active_sprint_has_dates",
            ),
            models.CheckConstraint(condition=GreaterThan(Length(Trim("name")), 0), name="ck_sprint_name_not_blank"),
            models.CheckConstraint(condition=LessThanOrEqual(Length("goal"), SPRINT_GOAL_MAX), name="ck_sprint_goal_max"),
            # Closed exactly when completed: velocity and reports rely on the pair.
            models.CheckConstraint(
                condition=(Q(state="closed") & Q(completed_at__isnull=False))
                | (~Q(state="closed") & Q(completed_at__isnull=True)),
                name="ck_sprint_completed_at_iff_closed",
            ),
        ]

    def __str__(self):
        return f"{self.project.key} · {self.name}"
