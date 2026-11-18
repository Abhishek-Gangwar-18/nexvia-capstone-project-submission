from django.contrib.auth import get_user_model
from django.db.models import Q
from rest_framework import serializers
from rest_framework.relations import MANY_RELATION_KWARGS

BIGINT_MAX = 2 ** 63 - 1


class BulkTenantManyRelatedField(serializers.ManyRelatedField):
    """many=True version of TenantPrimaryKeyRelatedField that validates every id in ONE workspace-scoped query
    (DRF's default does one query per id). Same error messages and same duplicate handling as before."""

    def to_internal_value(self, data):
        if isinstance(data, (str, dict)) or not hasattr(data, "__iter__"):
            self.fail("not_a_list", input_type=type(data).__name__)
        if not self.allow_empty and len(data) == 0:
            self.fail("empty")
        child = self.child_relation
        pks = []
        for item in data:
            if isinstance(item, bool):
                child.fail("incorrect_type", data_type=type(item).__name__)
            try:
                pk = int(item)
            except (TypeError, ValueError):
                child.fail("incorrect_type", data_type=type(item).__name__)
            if pk < 1 or pk > BIGINT_MAX:  # can't exist; don't send an out-of-range value to PostgreSQL
                child.fail("does_not_exist", pk_value=item)
            pks.append(pk)
        found = {obj.pk: obj for obj in child.get_queryset().filter(pk__in=set(pks))}  # scoped to the workspace
        missing = next((pk for pk in pks if pk not in found), None)
        if missing is not None:
            child.fail("does_not_exist", pk_value=missing)
        return [found[pk] for pk in pks]


class TenantPrimaryKeyRelatedField(serializers.PrimaryKeyRelatedField):
    """PK field whose choices are limited to the request's workspace: a foreign id is 'does not exist'."""

    @classmethod
    def many_init(cls, *args, **kwargs):
        list_kwargs = {"child_relation": cls(*args, **kwargs)}
        list_kwargs.update({key: value for key, value in kwargs.items() if key in MANY_RELATION_KWARGS})
        return BulkTenantManyRelatedField(**list_kwargs)

    def get_queryset(self):
        request = self.context.get("request")
        return super().get_queryset().for_workspace(getattr(request, "workspace", None))


class WorkspaceMemberField(serializers.PrimaryKeyRelatedField):
    """User PK field limited to *active* members of the request's workspace. A deactivated user can't be
    newly assigned, but a value that is already set on the object stays valid, so re-saving it still works."""

    def get_queryset(self):
        request = self.context.get("request")
        workspace = getattr(request, "workspace", None)
        users = get_user_model().objects
        if not workspace:
            return users.none()
        allowed = Q(is_active=True)
        instance = getattr(self.parent, "instance", None)
        current = getattr(instance, f"{self.source}_id", None) if instance is not None and self.source else None
        if current is not None:
            allowed |= Q(pk=current)
        return users.filter(allowed, memberships__workspace=workspace)
