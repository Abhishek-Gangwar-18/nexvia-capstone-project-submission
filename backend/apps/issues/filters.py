from datetime import datetime, time, timedelta

from django.db.models import Exists, OuterRef
from django.utils import timezone
from django_filters import rest_framework as filters

from apps.projects.models import WorkflowStatus

from .models import AuditLog, Issue


class NumberInFilter(filters.BaseInFilter, filters.NumberFilter):
    pass


class CharInFilter(filters.BaseInFilter, filters.CharFilter):
    pass


class IssueFilter(filters.FilterSet):
    project = filters.CharFilter(method="filter_project", help_text="Project id or key")
    sprint = filters.CharFilter(method="filter_sprint", help_text="Sprint id, 'active' or 'backlog'")
    assignee = filters.CharFilter(method="filter_assignee", help_text="User id, 'me' or 'none'")
    status = NumberInFilter(field_name="status_id")
    status_category = CharInFilter(field_name="status__category")
    issue_type = CharInFilter(field_name="issue_type")
    exclude_type = CharInFilter(field_name="issue_type", exclude=True)
    priority = NumberInFilter(field_name="priority")
    label = filters.NumberFilter(method="filter_label")
    parent = filters.NumberFilter(field_name="parent_id")
    overdue = filters.BooleanFilter(method="filter_overdue")

    class Meta:
        model = Issue
        fields = []

    def filter_project(self, qs, name, value):
        return qs.filter(project_id=value) if value.isdigit() else qs.filter(project__key=value.upper())

    def filter_sprint(self, qs, name, value):
        if value == "active":
            return qs.filter(sprint__state="active")
        if value in ("backlog", "none"):
            return qs.filter(sprint__isnull=True)
        return qs.filter(sprint_id=value) if value.isdigit() else qs.none()

    def filter_assignee(self, qs, name, value):
        if value == "me":
            return qs.filter(assignee=self.request.user)
        if value in ("none", "unassigned"):
            return qs.filter(assignee__isnull=True)
        ids = [v for v in value.split(",") if v.isdigit()]
        return qs.filter(assignee_id__in=ids)

    def filter_label(self, qs, name, value):
        # EXISTS instead of JOIN + DISTINCT: a semi-join can't duplicate issues, so no sort/hash over wide rows.
        links = Issue.labels.through.objects.filter(issue_id=OuterRef("pk"), label_id=value)
        return qs.filter(Exists(links))

    def filter_overdue(self, qs, name, value):
        if not value:
            return qs
        return qs.filter(due_date__lt=timezone.localdate()).exclude(status__category=WorkflowStatus.Category.DONE)


class AuditLogFilter(filters.FilterSet):
    entity_type = filters.CharFilter(field_name="entity_type")
    action = filters.CharFilter(field_name="action")
    actor = filters.NumberFilter(field_name="actor_id")
    # Keys are canonical uppercase (DB CHECK on projects), so uppercase the input and match exactly.
    project = filters.CharFilter(method="filter_project_key")
    # Same records as created_at__date >= / <= (dates in the current timezone, UTC), written as a plain
    # timestamp range so the (workspace_id, created_at) index can serve it instead of casting every row.
    date_from = filters.DateFilter(method="filter_date_from")
    date_to = filters.DateFilter(method="filter_date_to")

    class Meta:
        model = AuditLog
        fields = []

    def filter_project_key(self, qs, name, value):
        return qs.filter(project_key=value.strip().upper())

    @staticmethod
    def _start_of(day):
        return timezone.make_aware(datetime.combine(day, time.min), timezone.get_current_timezone())

    def filter_date_from(self, qs, name, value):
        return qs.filter(created_at__gte=self._start_of(value))

    def filter_date_to(self, qs, name, value):
        return qs.filter(created_at__lt=self._start_of(value + timedelta(days=1)))
