from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models, transaction
from django.db.models import Max, Q
from django.db.models.functions import Length, Lower, Trim
from django.db.models.lookups import GreaterThan, LessThanOrEqual
from django.utils import timezone

from apps.core.models import TenantModel, choices_check, hex_color_check, workspace_fk_without_index
from apps.projects.models import Project, Sprint, WorkflowStatus
from apps.tenants.models import Membership

RANK_STEP = 1024.0
LABEL_NAME_MAX = 40
LABELS_PER_WORKSPACE = 500  # the label picker loads them all; stays well under the 1,000-row list cap
LABELS_PER_ISSUE = 20


def canonical_label_name(value):
    """The one rule for label names: trim, Unicode case-fold, NFC. casefold() (not lower()) makes caseless
    variants identical, e.g. "ΣΑΣ", "σας" and "σασ" all become "σασ"; NFC makes composed and decomposed
    forms ("é" vs "e" + U+0301) identical. The length limit applies to this result, since folding can
    lengthen a string ("İ" becomes 2 characters)."""
    import unicodedata

    return unicodedata.normalize("NFC", unicodedata.normalize("NFC", value.strip()).casefold())


class Label(TenantModel):
    # unique_label_per_workspace starts with workspace_id, so a separate single-column index is redundant
    # (benchmarked at 100k rows: the planner uses the composite at equal or better speed).
    workspace = workspace_fk_without_index()
    name = models.CharField(max_length=LABEL_NAME_MAX)
    color = models.CharField(max_length=7, default="#64748b")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["workspace", "name"], name="unique_label_per_workspace"),
            # Names are stored lowercase, so "Bug" and "bug" collide in the unique constraint above.
            # A sanity check only: the application's canonical_label_name() is the real normalization rule.
            models.CheckConstraint(condition=Q(name=Lower("name")), name="label_name_lowercase"),
            models.CheckConstraint(condition=GreaterThan(Length(Trim("name")), 0), name="ck_label_name_not_blank"),
            hex_color_check("color", "ck_label_color_hex"),
        ]

    def __str__(self):
        return self.name

    def clean_fields(self, exclude=None):
        # Admin and other model-form paths: same canonical form and length rule as the API, as a field error.
        if self.name:
            self.name = canonical_label_name(self.name)
        super().clean_fields(exclude=exclude)

    def save(self, *args, **kwargs):
        if self.name:
            self.name = canonical_label_name(self.name)
        super().save(*args, **kwargs)



class IssueIssueType(models.TextChoices):
    EPIC = "epic", "Epic"
    STORY = "story", "Story"
    TASK = "task", "Task"
    BUG = "bug", "Bug"
    SUBTASK = "subtask", "Sub-task"



class IssuePriority(models.IntegerChoices):
    LOWEST = 1, "Lowest"
    LOW = 2, "Low"
    MEDIUM = 3, "Medium"
    HIGH = 4, "High"
    HIGHEST = 5, "Highest"


class Issue(TenantModel):
    IssueType = IssueIssueType

    Priority = IssuePriority

    # Composite indexes below start with workspace_id, so a separate single-column index is redundant
    # (benchmarked at 100k rows: the planner uses the composite at equal or better speed).
    workspace = workspace_fk_without_index()
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="issues")
    number = models.PositiveIntegerField(editable=False)
    # Derived and stored on purpose: "<project.key>-<number>", written once in save() and never changed.
    # It stays correct because Project.key is immutable (the API refuses to change it) and number is
    # never reassigned. A CHECK can't compare against another table, so this invariant is app-enforced.
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
    # Not indexed on its own: every board/backlog query filters by project first and sorts ~1k rows in
    # memory (0.35 ms at 100k issues). Revisit with (project_id, rank, id) if one project nears ~50k issues.
    rank = models.FloatField(default=0)
    labels = models.ManyToManyField(Label, blank=True, related_name="issues")
    resolved_at = models.DateTimeField(null=True, blank=True)

    tenant_parent = "project"

    class Meta:
        ordering = ["rank", "id"]
        constraints = [
            models.UniqueConstraint(fields=["project", "number"], name="unique_issue_number_per_project"),
            models.UniqueConstraint(fields=["workspace", "key"], name="unique_issue_key_per_workspace"),
            choices_check("issue_type", IssueIssueType.choices, "ck_issue_type"),
            models.CheckConstraint(condition=Q(priority__gte=1, priority__lte=5), name="ck_issue_priority_1_5"),
            models.CheckConstraint(
                condition=Q(story_points__isnull=True) | Q(story_points__lte=100), name="ck_issue_story_points_max_100"
            ),
            # NaN/Infinity would break the midpoint arithmetic used for drag-and-drop ordering.
            models.CheckConstraint(
                condition=Q(rank__gt=float("-inf")) & Q(rank__lt=float("inf")), name="ck_issue_rank_finite"
            ),
            # 50,000 characters, the same limit as IssueSerializer: also bounds what the trigram index indexes.
            models.CheckConstraint(
                condition=LessThanOrEqual(Length("description"), 50_000), name="ck_issue_description_max"
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "status"]),
            models.Index(fields=["workspace", "sprint"]),
            models.Index(fields=["workspace", "assignee"]),
            # Trigram GIN indexes for ?search= live in migration 0009 as raw SQL: Django renders
            # OpClass(Upper(...)) with parentheses PostgreSQL rejects.
        ]

    def __str__(self):
        return f"{self.key} {self.title}"

    def save(self, *args, **kwargs):
        # Which columns this save writes (None = all). check_tenant_integrity uses it to skip re-validating
        # an assignee that isn't being written, e.g. on a title-only PATCH.
        update_fields = kwargs.get("update_fields")
        self._saving_fields = set(update_fields) if update_fields is not None else None
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
        # The reporter is historical: they may leave the workspace later, and that must not lock the issue.
        # Assignees are cleared when a member leaves (see signals.py), so that check always applies.
        saving = getattr(self, "_saving_fields", None)
        for field in ("assignee", "reporter") if self._state.adding else ("assignee",):
            if saving is not None and field not in saving:
                continue  # not written by this save (unchanged), so there is nothing new to validate
            user_id = getattr(self, f"{field}_id")
            if user_id and not Membership.objects.filter(workspace_id=self.workspace_id, user_id=user_id).exists():
                errors[field] = "User is not a member of this workspace."
        if errors:
            raise ValidationError(errors)


class IssueComment(TenantModel):
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="issue_comments")
    body = models.TextField(max_length=10000)
    mentions = models.ManyToManyField(settings.AUTH_USER_MODEL, blank=True, related_name="mentioned_in_comments")

    tenant_parent = "issue"

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            # Same limit as the serializer and the admin form (both from max_length above). TextField's
            # max_length alone creates no DB constraint; char_length counts characters, not bytes.
            models.CheckConstraint(
                condition=LessThanOrEqual(Length("body"), 10_000), name="ck_comment_body_max"
            ),
        ]

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        if self._state.adding and self.author_id and not Membership.objects.filter(workspace_id=self.workspace_id, user_id=self.author_id).exists():
            raise ValidationError({"author": "Author is not a member of this workspace."})


def attachment_path(instance, filename):
    """issues/2026/11/<uuid4 hex><ext>: short, unguessable and collision-free. The user's own filename is
    kept in `original_name` for display and downloads."""
    import uuid
    from pathlib import PurePath

    from django.utils import timezone

    suffix = PurePath(filename).suffix.lower()[:10]
    return f"issues/{timezone.now():%Y/%m}/{uuid.uuid4().hex}{suffix}"


# The single content type stored for each allowed extension. The upload serializer verifies the bytes and
# stores exactly these values; the DB CHECK below enforces the same list (keep both in one change).
ATTACHMENT_TYPES = {
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".zip": "application/zip",
}
ATTACHMENT_CONTENT_TYPES = sorted(set(ATTACHMENT_TYPES.values()))
ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024  # == settings.FILE_UPLOAD_HARD_LIMIT (a test keeps them equal)


class IssueAttachment(TenantModel):
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="attachments")
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="issue_attachments")
    file = models.FileField(upload_to=attachment_path, max_length=255)
    original_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=120)
    size = models.PositiveBigIntegerField()

    tenant_parent = "issue"

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.CheckConstraint(condition=models.Q(size__lte=ATTACHMENT_MAX_BYTES), name="ck_attachment_size_max"),
            models.CheckConstraint(condition=models.Q(content_type__in=ATTACHMENT_CONTENT_TYPES),
                                   name="ck_attachment_content_type_allowed"),
        ]

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        if self._state.adding and self.uploaded_by_id and not Membership.objects.filter(workspace_id=self.workspace_id, user_id=self.uploaded_by_id).exists():
            raise ValidationError({"uploaded_by": "Uploader is not a member of this workspace."})



class AuditLogAction(models.TextChoices):
    CREATED = "created", "Created"
    UPDATED = "updated", "Updated"
    MOVED = "moved", "Moved"
    COMMENTED = "commented", "Commented"
    ATTACHED = "attached", "Attachment added"
    DETACHED = "detached", "Attachment removed"
    DELETED = "deleted", "Deleted"
    ARCHIVED = "archived", "Archived"
    RESTORED = "restored", "Restored"
    STARTED = "started", "Started"
    COMPLETED = "completed", "Completed"
    INVITED = "invited", "Invited"
    REVOKED = "revoked", "Revoked"
    JOINED = "joined", "Joined"
    LEFT = "left", "Left"
    REMOVED = "removed", "Removed"
    ROLE_CHANGED = "role_changed", "Role changed"
    SECRET_ROTATED = "secret_rotated", "Secret rotated"
    PLAN_CHANGED = "plan_changed", "Plan changed"
    OWNERSHIP_TRANSFERRED = "ownership_transferred", "Ownership transferred"



class AuditLogEntity(models.TextChoices):
    ISSUE = "issue", "Issue"
    PROJECT = "project", "Project"
    SPRINT = "sprint", "Sprint"
    WORKFLOW = "workflow", "Workflow"
    BOARD = "board", "Board"
    MEMBER = "member", "Member"
    INVITATION = "invitation", "Invitation"
    WORKSPACE = "workspace", "Workspace"
    LABEL = "label", "Label"
    WEBHOOK = "webhook", "Webhook"
    BILLING = "billing", "Billing"


class AuditLog(TenantModel):
    """Who changed what in a workspace. Survives deletion of what it describes, so labels are stored as text.

    Retention: kept indefinitely on purpose. It is the evidence for security reviews, ownership and billing
    changes, so the nightly purge (automation.tasks.purge_old_records) deliberately skips it. A configurable
    retention period, or monthly partitioning, should be decided from customer, legal and volume needs.
    "Indefinitely" means for the life of the workspace: deleting a workspace (owner, slug + password confirmed)
    is the tenant's erase-my-data action and cascades to its history. Keeping history beyond that would need a
    separate archival/legal design.

    Append-only: the app only ever inserts. No API, service or task updates or deletes rows, the admin is
    read-only, and project deletion no longer touches them (see `project`). The remaining DB-side writes are
    the workspace cascade above and actor SET NULL when a user is hard-deleted (no such endpoint exists).
    This is an application invariant, not a DB-enforced one (no trigger), by decision."""

    Action = AuditLogAction

    updated_at = None  # rows are never updated, so only created_at (inherited) is kept

    Entity = AuditLogEntity

    # Composite indexes below start with workspace_id, so a separate single-column index is redundant
    # (benchmarked at 100k rows: the planner uses the composite at equal or better speed).
    workspace = workspace_fk_without_index()
    entity_type = models.CharField(max_length=16, choices=Entity.choices, default=Entity.ISSUE)
    entity_label = models.CharField(max_length=255, blank=True)
    issue_key = models.CharField(max_length=24, blank=True)  # served by (workspace, issue_key, created_at)
    issue_title = models.CharField(max_length=255, blank=True)
    # A plain historical reference, not an enforced FK: deleting a project must not rewrite its (possibly
    # hundreds of thousands of) audit rows. project_key keeps the readable reference; project_id may point at a
    # project that no longer exists. No index of its own: the activity query is served by
    # (workspace, issue_key, created_at), and with no FK there is no cascade lookup to support.
    project = models.ForeignKey(
        Project, on_delete=models.DO_NOTHING, db_constraint=False, db_index=False,
        null=True, blank=True, related_name="audit_events",
    )
    project_key = models.CharField(max_length=10, blank=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="audit_events")
    action = models.CharField(max_length=32, choices=Action.choices)
    changes = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["workspace", "issue_key", "created_at"]),
            models.Index(fields=["workspace", "-created_at"]),
        ]
        constraints = [
            choices_check("entity_type", AuditLogEntity.choices, "ck_auditlog_entity_type"),
            choices_check("action", AuditLogAction.choices, "ck_auditlog_action"),
        ]

    def save(self, *args, **kwargs):
        if self.project_id and not self.project_key:
            self.project_key = self.project.key
        if self.issue_key and not self.entity_label:
            self.entity_label = f"{self.issue_key} {self.issue_title}"[:255]
        super().save(*args, **kwargs)

    def check_tenant_integrity(self):
        super().check_tenant_integrity()
        if self._state.adding and self.actor_id and not Membership.objects.filter(workspace_id=self.workspace_id, user_id=self.actor_id).exists():
            raise ValidationError({"actor": "Actor is not a member of this workspace."})
