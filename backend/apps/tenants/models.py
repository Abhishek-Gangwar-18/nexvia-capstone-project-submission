import secrets
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.text import slugify

from apps.core.models import TimeStampedModel


class Workspace(TimeStampedModel):
    """The tenant. Every tenant-owned row carries a FK to one of these."""

    class Plan(models.TextChoices):
        FREE = "free", "Free"
        PRO = "pro", "Pro"
        ENTERPRISE = "enterprise", "Enterprise"

    name = models.CharField(max_length=100)
    slug = models.SlugField(max_length=60, unique=True)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="owned_workspaces"
    )
    plan = models.CharField(max_length=20, choices=Plan.choices, default=Plan.FREE)
    members = models.ManyToManyField(
        settings.AUTH_USER_MODEL, through="Membership", related_name="workspaces"
    )

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = self._unique_slug()
        super().save(*args, **kwargs)

    def _unique_slug(self):
        base = slugify(self.name)[:50] or "workspace"
        slug, n = base, 2
        while Workspace.objects.filter(slug=slug).exclude(pk=self.pk).exists():
            slug, n = f"{base}-{n}", n + 1
        return slug


class Membership(TimeStampedModel):
    class Role(models.TextChoices):
        OWNER = "owner", "Owner"
        ADMIN = "admin", "Admin"
        MEMBER = "member", "Member"
        VIEWER = "viewer", "Viewer"

    # Higher number = more privilege; permissions compare against this ladder.
    ROLE_RANK = {Role.VIEWER: 0, Role.MEMBER: 1, Role.ADMIN: 2, Role.OWNER: 3}

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="memberships"
    )
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.MEMBER)

    class Meta:
        ordering = ["workspace", "user__email"]
        constraints = [
            models.UniqueConstraint(fields=["workspace", "user"], name="unique_membership"),
        ]

    def __str__(self):
        return f"{self.user} @ {self.workspace} ({self.role})"

    def has_role(self, minimum_role):
        return self.ROLE_RANK[self.role] >= self.ROLE_RANK[minimum_role]


def generate_invite_token():
    return secrets.token_urlsafe(32)


def default_invite_expiry():
    return timezone.now() + timedelta(days=7)


class Invitation(TimeStampedModel):
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="invitations")
    email = models.EmailField()
    role = models.CharField(max_length=10, choices=Membership.Role.choices, default=Membership.Role.MEMBER)
    token = models.CharField(max_length=64, unique=True, default=generate_invite_token, editable=False)
    invited_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+")
    expires_at = models.DateTimeField(default=default_invite_expiry)
    accepted_at = models.DateTimeField(null=True, blank=True)
    email_sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.email} → {self.workspace}"

    @property
    def is_pending(self):
        return self.accepted_at is None and self.expires_at > timezone.now()

    @property
    def accept_url(self):
        return f"{settings.FRONTEND_URL.rstrip('/')}/invite/{self.token}"
