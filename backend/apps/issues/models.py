from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models, transaction
from django.db.models import Max
from django.utils import timezone

from apps.core.models import TenantModel
from apps.projects.models import Project, Sprint, WorkflowStatus
from apps.tenants.models import Membership

RANK_STEP = 1024.0


class Label(TenantModel):
    name = models.CharField(max_length=40)
    color = models.CharField(max_length=7, default="#64748b")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["workspace", "name"], name="unique_label_per_workspace"),
        ]

    def __str__(self):
        return self.name


class Issue(TenantModel):
    class IssueType(models.TextChoices):
        EPIC = "epic", "Epic"
        STORY = "story", "Story"
        TASK = "task", "Task"
        BUG = "bug", "Bug"
        SUBTASK = "subtask", "Sub-task"

    class Priority(models.IntegerChoices):
        LOWEST = 1, "Lowest"
        LOW = 2, "Low"
        MEDIUM = 3, "Medium"
        HIGH = 4, "High"
        HIGHEST = 5, "Highest"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="issues")
    number = models.PositiveIntegerField(editable=False)
    key = models.CharField(max_length=24, editable=False)
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    issue_type = models.CharField(max_length=10, choices=IssueType.choices, default=IssueType.TASK)
    priority = models.PositiveSmallIntegerField(choices=Priority.choices, default=Priority.MEDIUM)
    # RESTRICT (not PROTECT): a status in use can't be deleted on its own, but deleting the whole
    # project/workspace cascades through both the status and its issues.
    status = models.ForeignKey(WorkflowStatus, on_delete=models.RESTRICT, related_name="issues")
    sprint = models.ForeignKey(Sprint, on_delete=models.SET_NULL, null=True, blank=True, related_name="issues")
    parent = models.ForeignKey("self", on_delete=models.SET_NULL, null=True, blank=True, related_name="children")
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="assigned_issues"
    )
    reporter = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="reported_issues"
    )
    story_points = models.PositiveSmallIntegerField(null=True, blank=True)
    due_date = models.DateField(null=True, blank=True)
    # Ordering inside a board column / backlog. Floats let a drag-and-drop insert between two
    # neighbours by averaging their ranks without renumbering the whole column.
    rank = models.FloatField(default=0, db_index=True)
    labels = models.ManyToManyField(Label, blank=True, related_name="issues")
    resolved_at = models.DateTimeField(null=True, blank=True)

    tenant_parent = "project"

    class Meta:
        ordering = ["rank", "id"]
        constraints = [
            models.UniqueConstraint(fields=["project", "number"], name="unique_issue_number_per_project"),
            models.UniqueConstraint(fields=["workspace", "key"], name="unique_issue_key_per_workspace"),
        ]
        indexes = [
            models.Index(fields=["workspace", "status"]),
            models.Index(fields=["workspace", "sprint"]),
            models.Index(fields=["workspace", "assignee"]),
        ]

    def __str__(self):
        return f"{self.key} {self.title}"

    def save(self, *args, **kwargs):
        with transaction.atomic():
            if self.status_id is None and self.project_id is not None:
                self.status = self.project.default_status
            if not self.number:
                self.number = self.project.allocate_issue_number()
                self.key = f"{self.project.key}-{self.number}"
            if self._state.adding and not self.rank:
                top = Issue.objects.filter(project_id=self.project_id, status_id=self.status_id).aggregate(
                    m=Max("rank")
                )["m"]
                self.rank = (top or 0) + RANK_STEP
            self._sync_resolution()
            super().save(*args, **kwargs)

    def _sync_resolution(self):
        is_done = self.status.category == WorkflowStatus.Category.DONE
        if is_done and self.resolved_at is None:
            self.resolved_at = timezone.now()
        elif not is_done:
            self.resolved_at = None

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        errors = {}
        if self.status.workflow.project_id != self.project_id:
            errors["status"] = "Status does not belong to this project's workflow."
        if self.sprint_id and self.sprint.project_id != self.project_id:
            errors["sprint"] = "Sprint belongs to a different project."
        if self.parent_id and self.parent.project_id != self.project_id:
            errors["parent"] = "Parent issue belongs to a different project."
        if self.parent_id and self.pk and self.parent_id == self.pk:
            errors["parent"] = "An issue cannot be its own parent."
        for field in ("assignee", "reporter"):
            user_id = getattr(self, f"{field}_id")
            if user_id and not Membership.objects.filter(workspace_id=self.workspace_id, user_id=user_id).exists():
                errors[field] = "User is not a member of this workspace."
        if errors:
            raise ValidationError(errors)
