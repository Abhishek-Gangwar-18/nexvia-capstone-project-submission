import hashlib
import secrets
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.db.models.functions import Length, Lower, Trim
from django.db.models.lookups import GreaterThan
from django.utils import timezone
from django.utils.text import slugify

from apps.core.models import TimeStampedModel, choices_check



class WorkspacePlan(models.TextChoices):
    FREE = "free", "Free"
    PRO = "pro", "Pro"
    ENTERPRISE = "enterprise", "Enterprise"


SLUG_PATTERN = r"^[a-z0-9]+(-[a-z0-9]+)*$"


def slugify_workspace(name):
    """slugify() keeps underscores and can leave a hyphen after truncation; the slug format allows neither."""
    import re

    return re.sub(r"[^a-z0-9]+", "-", slugify(name))[:50].strip("-") or "workspace"


class Workspace(TimeStampedModel):
    """The tenant. Every tenant-owned row carries a FK to one of these."""

    Plan = WorkspacePlan

    name = models.CharField(max_length=100)
    slug = models.SlugField(max_length=60, unique=True)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="owned_workspaces"
    )
    plan = models.CharField(max_length=20, choices=Plan.choices, default=Plan.FREE)
    # Set when the owner deletes the workspace. From then on it is invisible to every API path and a
    # background task removes its data in batches (apps/tenants/deletion.py); the row itself goes last.
    deleting_at = models.DateTimeField(null=True, blank=True, editable=False)
    members = models.ManyToManyField(
        settings.AUTH_USER_MODEL, through="Membership", related_name="workspaces"
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            choices_check("plan", WorkspacePlan.choices, "ck_workspace_plan"),
            # Exactly what slugify_workspace() produces: lowercase words joined by single hyphens. The slug is
            # matched case-sensitively in X-Workspace and /w/<slug> URLs, so "Acme" would break every link.
            models.CheckConstraint(condition=Q(slug__regex=SLUG_PATTERN), name="ck_workspace_slug_format"),
            models.CheckConstraint(condition=GreaterThan(Length(Trim("name")), 0), name="ck_workspace_name_not_blank"),
        ]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = self._unique_slug()
        super().save(*args, **kwargs)

    def _unique_slug(self):
        """One query: the base slug plus every "base-..." slug (a LIKE 'base-%' prefix scan, served by the
        slug_like varchar_pattern_ops index), then the highest numeric suffix + 1. Two concurrent creates can
        still pick the same candidate; the unique constraint and _insert_workspace's retry handle that."""
        base = slugify_workspace(self.name)
        candidates = Workspace.objects.filter(Q(slug=base) | Q(slug__startswith=f"{base}-")).order_by()
        if self.pk:
            candidates = candidates.exclude(pk=self.pk)
        taken = set(candidates.values_list("slug", flat=True))
        if base not in taken:
            return base
        suffixes = [int(s[len(base) + 1:]) for s in taken if s[len(base) + 1:].isdigit()]
        return f"{base}-{max(suffixes, default=1) + 1}"

    @property
    def is_deleting(self):
        return self.deleting_at is not None



class MembershipRole(models.TextChoices):
    OWNER = "owner", "Owner"
    ADMIN = "admin", "Admin"
    MEMBER = "member", "Member"
    VIEWER = "viewer", "Viewer"


class Membership(TimeStampedModel):
    Role = MembershipRole

    # Higher number = more privilege; permissions compare against this ladder.
    ROLE_RANK = {Role.VIEWER: 0, Role.MEMBER: 1, Role.ADMIN: 2, Role.OWNER: 3}

    # unique_membership (workspace, user) already indexes workspace_id first.
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="memberships", db_index=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="memberships"
    )
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.MEMBER)

    class Meta:
        # No default ordering on purpose: it silently added JOINs to accounts_user and tenants_workspace (for
        # ORDER BY name, email) to every .first(), slice and subquery, including the per-request workspace
        # check. Queries that show members in order say so explicitly (MemberViewSet, admin).
        ordering = []
        constraints = [
            models.UniqueConstraint(fields=["workspace", "user"], name="unique_membership"),
            choices_check("role", MembershipRole.choices, "ck_membership_role"),
            # At most one owner membership per workspace. Workspace.owner_id must point at the same user;
            # transfer_ownership() changes both in one transaction (demote first, then promote).
            models.UniqueConstraint(fields=["workspace"], condition=Q(role="owner"), name="uq_one_owner_per_workspace"),
        ]

    def __str__(self):
        return f"{self.user} @ {self.workspace} ({self.role})"

    def has_role(self, minimum_role):
        return self.ROLE_RANK[self.role] >= self.ROLE_RANK[minimum_role]


def generate_invite_token():
    """A raw invite token: 256 random bits. Sent in the email and shown once; never stored."""
    return secrets.token_urlsafe(32)


def hash_invite_token(raw):
    """SHA-256 is right here (no slow KDF needed): the token is random and high-entropy, not a password."""
    return hashlib.sha256(raw.encode()).hexdigest()


def unusable_token_hash():
    """Default for rows created without issue_token(): the hash of a token nobody ever saw."""
    return hash_invite_token(generate_invite_token())


def default_invite_expiry():
    return timezone.now() + timedelta(days=7)


class Invitation(TimeStampedModel):
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="invitations")
    email = models.EmailField()  # stored lowercase (ck_invitation_email_lowercase), compared exactly
    role = models.CharField(max_length=10, choices=Membership.Role.choices, default=Membership.Role.MEMBER)
    # Only the SHA-256 of the invite token is stored: a DB dump or backup can't be used to join a workspace.
    # Uniqueness is a UniqueConstraint (not unique=True) so no varchar_pattern_ops index is created for it.
    token_hash = models.CharField(max_length=64, default=unusable_token_hash, editable=False)
    invited_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+")
    expires_at = models.DateTimeField(default=default_invite_expiry)
    accepted_at = models.DateTimeField(null=True, blank=True)
    email_sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            # One open invitation per email per workspace; expired rows are deleted before re-inviting. Emails are
            # stored lowercase, so a plain (workspace, email) index serves the exact lookups the code runs.
            models.UniqueConstraint(
                fields=["workspace", "email"], condition=Q(accepted_at__isnull=True), name="unique_open_invitation"
            ),
            models.CheckConstraint(condition=Q(email=Lower("email")), name="ck_invitation_email_lowercase"),
            models.UniqueConstraint(fields=["token_hash"], name="uq_invitation_token_hash"),
            # Nobody is ever invited as owner: ownership only moves through transfer-ownership.
            models.CheckConstraint(condition=Q(role__in=["admin", "member", "viewer"]), name="ck_invitation_role"),
        ]

    def __str__(self):
        return f"{self.email} → {self.workspace}"

    def save(self, *args, **kwargs):
        if self.email:
            self.email = self.email.strip().lower()
        super().save(*args, **kwargs)

    def issue_token(self):
        """Give this invitation a fresh token (invalidating any earlier link) and return the raw value.
        The raw token is kept on the instance only for this request, to build accept_url once."""
        raw = generate_invite_token()
        self.token_hash = hash_invite_token(raw)
        self._raw_token = raw
        return raw

    @property
    def is_authorized(self):
        """An admin invitation stays valid only while its sender still owns the workspace."""
        return self.role != Membership.Role.ADMIN or (
            self.invited_by_id is not None and self.invited_by_id == self.workspace.owner_id
        )

    @property
    def is_usable(self):
        return self.is_pending and self.is_authorized

    @property
    def is_pending(self):
        return self.accepted_at is None and self.expires_at > timezone.now()

    @property
    def accept_url(self):
        """Only right after issue_token() (create or resend). Later reads return None: the link can't be rebuilt."""
        raw = getattr(self, "_raw_token", None)
        return f"{settings.FRONTEND_URL.rstrip('/')}/invite/{raw}" if raw else None
