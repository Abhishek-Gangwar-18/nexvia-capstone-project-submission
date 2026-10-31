from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import RegexValidator
from django.db import models
from django.db.models import F, Q

from apps.core.models import TenantModel

PROJECT_KEY_VALIDATOR = RegexValidator(
    r"^[A-Z][A-Z0-9]{1,9}$", "Key must be 2-10 uppercase letters/digits, starting with a letter."
)


class Project(TenantModel):
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

    def __str__(self):
        return self.name

    def can_transition(self, from_status, to_status):
        if from_status is None or from_status.pk == to_status.pk or not self.enforce_transitions:
            return True
        return self.transitions.filter(from_status=from_status, to_status=to_status).exists()


class WorkflowStatus(TenantModel):
    class Category(models.TextChoices):
        TODO = "todo", "To Do"
        IN_PROGRESS = "in_progress", "In Progress"
        DONE = "done", "Done"

    workflow = models.ForeignKey(Workflow, on_delete=models.CASCADE, related_name="statuses")
    name = models.CharField(max_length=40)
    category = models.CharField(max_length=20, choices=Category.choices, default=Category.TODO)
    color = models.CharField(max_length=7, default="#64748b")
    position = models.PositiveIntegerField(default=0)

    tenant_parent = "workflow"

    class Meta:
        ordering = ["position", "id"]
        verbose_name_plural = "workflow statuses"
        constraints = [
            models.UniqueConstraint(fields=["workflow", "name"], name="unique_status_name_per_workflow"),
        ]

    def __str__(self):
        return self.name


class WorkflowTransition(TenantModel):
    workflow = models.ForeignKey(Workflow, on_delete=models.CASCADE, related_name="transitions")
    from_status = models.ForeignKey(WorkflowStatus, on_delete=models.CASCADE, related_name="outgoing")
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


class Board(TenantModel):
    class BoardType(models.TextChoices):
        KANBAN = "kanban", "Kanban"
        SCRUM = "scrum", "Scrum"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="boards")
    name = models.CharField(max_length=120)
    board_type = models.CharField(max_length=10, choices=BoardType.choices, default=BoardType.SCRUM)
    # {"<status_id>": <max issues>} - columns are the project's workflow statuses.
    wip_limits = models.JSONField(default=dict, blank=True)

    tenant_parent = "project"

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class Sprint(TenantModel):
    class State(models.TextChoices):
        PLANNED = "planned", "Planned"
        ACTIVE = "active", "Active"
        CLOSED = "closed", "Closed"

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
        ]

    def __str__(self):
        return f"{self.project.key} · {self.name}"
