from datetime import timedelta

from django.db.models import Count, Q
from django.db.models.functions import TruncDate
from django.utils import timezone
from rest_framework.generics import GenericAPIView
from rest_framework.response import Response

from apps.accounts.models import User
from apps.accounts.serializers import UserMiniSerializer
from apps.core.api import WorkspaceScopedMixin
from apps.projects.models import Project, Sprint, WorkflowStatus
from apps.projects.views import sprint_queryset

from .models import Issue
from .serializers import IssueListSerializer

DONE = WorkflowStatus.Category.DONE
TREND_DAYS = 14


class DashboardView(WorkspaceScopedMixin, GenericAPIView):
    """Aggregated numbers for the workspace home page, computed in a handful of grouped queries."""

    serializer_class = IssueListSerializer
    queryset = Issue.objects.none()

    def get(self, request):
        workspace = self.workspace
        today = timezone.localdate()
        issues = Issue.objects.for_workspace(workspace).filter(project__is_archived=False)
        open_issues = issues.exclude(status__category=DONE)
        ctx = self.get_serializer_context()

        totals = issues.aggregate(
            total=Count("id"),
            done=Count("id", filter=Q(status__category=DONE)),
            in_progress=Count("id", filter=Q(status__category=WorkflowStatus.Category.IN_PROGRESS)),
            overdue=Count("id", filter=Q(due_date__lt=today) & ~Q(status__category=DONE)),
            unassigned=Count("id", filter=Q(assignee__isnull=True) & ~Q(status__category=DONE)),
            mine_open=Count("id", filter=Q(assignee=request.user) & ~Q(status__category=DONE)),
            done_this_week=Count("id", filter=Q(resolved_at__date__gte=today - timedelta(days=7))),
        )
        totals["open"] = totals["total"] - totals["done"]

        by_category = dict(issues.values_list("status__category").annotate(c=Count("id")))
        by_type = dict(issues.values_list("issue_type").annotate(c=Count("id")))
        by_priority = dict(open_issues.values_list("priority").annotate(c=Count("id")))

        workload_rows = (
            open_issues.exclude(assignee=None).values("assignee").annotate(count=Count("id")).order_by("-count")[:8]
        )
        users = User.objects.in_bulk([row["assignee"] for row in workload_rows])
        workload = [
            {"user": UserMiniSerializer(users[row["assignee"]]).data, "count": row["count"]}
            for row in workload_rows
        ]

        since = today - timedelta(days=TREND_DAYS - 1)
        created = dict(
            issues.filter(created_at__date__gte=since).annotate(d=TruncDate("created_at"))
            .values_list("d").annotate(c=Count("id"))
        )
        resolved = dict(
            issues.filter(resolved_at__date__gte=since).annotate(d=TruncDate("resolved_at"))
            .values_list("d").annotate(c=Count("id"))
        )
        trend = []
        for offset in range(TREND_DAYS):
            day = since + timedelta(days=offset)
            trend.append({"date": day.isoformat(), "created": created.get(day, 0), "resolved": resolved.get(day, 0)})

        projects = (
            Project.objects.for_workspace(workspace).filter(is_archived=False)
            .annotate(total=Count("issues"), done=Count("issues", filter=Q(issues__status__category=DONE)))
            .order_by("name")
        )
        sprints = sprint_queryset(workspace).filter(state=Sprint.State.ACTIVE, project__is_archived=False)

        return Response({
            "totals": totals,
            "by_category": {c: by_category.get(c, 0) for c in WorkflowStatus.Category.values},
            "by_type": {t: by_type.get(t, 0) for t in Issue.IssueType.values},
            "by_priority": {str(p): by_priority.get(p, 0) for p in Issue.Priority.values},
            "workload": workload,
            "trend": trend,
            "projects": [
                {"id": p.id, "key": p.key, "name": p.name, "color": p.color, "total": p.total, "done": p.done}
                for p in projects
            ],
            "active_sprints": [
                {
                    "id": s.id, "name": s.name, "project_key": s.project.key, "project_name": s.project.name,
                    "start_date": s.start_date, "end_date": s.end_date, "goal": s.goal,
                    "issue_count": s.issue_count, "done_count": s.done_count,
                    "total_points": s.total_points, "done_points": s.done_points,
                    "days_left": max((s.end_date - today).days, 0) if s.end_date else None,
                }
                for s in sprints
            ],
            "my_issues": IssueListSerializer(
                open_issues.filter(assignee=request.user)
                .select_related("project", "status", "assignee", "reporter", "parent", "sprint")
                .prefetch_related("labels").order_by("-priority", "due_date", "-updated_at")[:8],
                many=True, context=ctx,
            ).data,
            "recent": IssueListSerializer(
                issues.select_related("project", "status", "assignee", "reporter", "parent", "sprint")
                .prefetch_related("labels").order_by("-updated_at")[:8],
                many=True, context=ctx,
            ).data,
        })
