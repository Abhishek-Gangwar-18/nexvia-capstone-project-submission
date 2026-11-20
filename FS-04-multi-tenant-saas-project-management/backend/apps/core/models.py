"""
Tenant isolation strategy: shared database, shared schema, `workspace_id` on every tenant row.

Three layers keep tenants apart:
1. Query layer   - `Model.objects.for_workspace(ws)` / `.current()` (fails closed with no context).
2. Write layer   - `TenantModel.save()` stamps the workspace (from its parent or the context) and
                   refuses any foreign key that points at another workspace's row.
3. API layer     - (Phase 2) viewsets resolve the workspace from the `X-Workspace` header, verify
                   membership, and only ever query through layer 1.
"""
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q

from .context import TenantContextMissing, get_current_workspace

HEX_COLOR_REGEX = r"^#[0-9a-fA-F]{6}$"


def choices_check(field, choices, name):
    """Django `choices` are only checked in Python; this makes PostgreSQL enforce them too, so raw SQL,
    bulk_create() and QuerySet.update() can't store a value the app doesn't know."""
    return models.CheckConstraint(condition=Q(**{f"{field}__in": [value for value, _ in choices]}), name=name)


def hex_color_check(field, name):
    """#RRGGBB only: colours are rendered as inline CSS."""
    return models.CheckConstraint(condition=Q(**{f"{field}__regex": HEX_COLOR_REGEX}), name=name)


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class TenantQuerySet(models.QuerySet):
    def for_workspace(self, workspace):
        if workspace is None:
            return self.none()
        return self.filter(workspace=workspace)

    def current(self):
        workspace = get_current_workspace()
        if workspace is None:
            raise TenantContextMissing(
                f"{self.model.__name__}.objects.current() called without a bound workspace"
            )
        return self.filter(workspace=workspace)


TenantManager = models.Manager.from_queryset(TenantQuerySet)


def workspace_fk_without_index():
    """The tenant FK, for models whose composite indexes already lead with workspace_id."""
    return models.ForeignKey("tenants.Workspace", on_delete=models.CASCADE, related_name="+", db_index=False)


class TenantModel(TimeStampedModel):
    workspace = models.ForeignKey(
        "tenants.Workspace",
        on_delete=models.CASCADE,
        related_name="+",
        db_index=True,
    )

    # Name of a FK whose `workspace` this row inherits when none is set explicitly.
    tenant_parent = None

    objects = TenantManager()

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        self._assign_workspace()
        self.check_tenant_integrity()
        super().save(*args, **kwargs)

    def _assign_workspace(self):
        if self.workspace_id is not None:
            return
        if self.tenant_parent:
            parent = getattr(self, self.tenant_parent, None)
            if parent is not None:
                self.workspace_id = parent.workspace_id
                return
        workspace = get_current_workspace()
        if workspace is None:
            raise TenantContextMissing(
                f"Cannot save {type(self).__name__} without a workspace (none set, no context bound)"
            )
        self.workspace = workspace

    def check_tenant_integrity(self):
        """Every FK to another tenant model must stay inside this row's workspace."""
        errors = {}
        for field in self._meta.concrete_fields:
            if not field.is_relation or field.name == "workspace":
                continue
            if not (isinstance(field.related_model, type) and issubclass(field.related_model, TenantModel)):
                continue
            if getattr(self, field.attname) is None:
                continue
            related = getattr(self, field.name)
            if related.workspace_id != self.workspace_id:
                errors[field.name] = "References a record from a different workspace."
        if errors:
            raise ValidationError(errors)
