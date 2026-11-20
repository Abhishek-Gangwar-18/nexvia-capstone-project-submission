import random

from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower

from apps.core.models import hex_color_check

AVATAR_COLORS = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e", "#f97316",
    "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
]


def random_avatar_color():
    return random.choice(AVATAR_COLORS)


class UserManager(BaseUserManager):
    use_in_migrations = True

    def _create_user(self, email, password, **extra_fields):
        if not email:
            raise ValueError("Users must have an email address")
        email = self.normalize_email(email).lower()
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra_fields)

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        if not extra_fields["is_staff"] or not extra_fields["is_superuser"]:
            raise ValueError("Superuser must have is_staff=True and is_superuser=True")
        return self._create_user(email, password, **extra_fields)


class User(AbstractUser):
    """Global identity. A user can belong to many workspaces via `tenants.Membership`."""

    username = None
    email = models.EmailField("email address", unique=True)
    avatar_color = models.CharField(max_length=7, default=random_avatar_color)
    job_title = models.CharField(max_length=100, blank=True)
    email_notifications = models.BooleanField(default=True)
    # When the profile row last changed. Like every auto_now field it is skipped by QuerySet.update(), and a
    # save(update_fields=[...]) that leaves it out (e.g. Django's last_login hook) doesn't touch it either,
    # so logging in is not a "profile change". Not an audit trail: it records when, not what.
    updated_at = models.DateTimeField(auto_now=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    objects = UserManager()

    class Meta:
        ordering = ["first_name", "last_name", "email"]
        constraints = [
            # Unique (above) plus lowercase means unique case-insensitively, whoever writes the row.
            models.CheckConstraint(condition=Q(email=Lower("email")), name="ck_user_email_lowercase"),
            hex_color_check("avatar_color", "ck_user_avatar_color_hex"),  # the palette itself is checked in the app
        ]

    def save(self, *args, **kwargs):
        # Every write path (register, admin forms, shell) stores the same normalised email.
        if self.email:
            self.email = self.email.strip().lower()
        super().save(*args, **kwargs)

    def __str__(self):
        return self.display_name

    @property
    def display_name(self):
        return self.get_full_name() or self.email.split("@")[0]

    @property
    def initials(self):
        parts = self.display_name.split()
        return "".join(p[0] for p in parts[:2]).upper() or self.email[0].upper()
