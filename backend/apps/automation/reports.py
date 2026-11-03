"""Builders for WorkspaceReport: each returns the JSON stored on the report, and csv_rows flattens it for export."""
from datetime import timedelta

from django.db.models import Count, IntegerField, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone

from apps.issues.models import Issue
from apps.projects.models import Sprint, WorkflowStatus

DONE = WorkflowStatus.Category.DONE
VELOCITY_SPRINTS = 10


def build_summary(report):
    issues = Issue.objects.for_workspace(report.workspace)
    return {
        "generated_at": timezone.now().isoformat(),
        "issue_count": issues.count(),
        "by_status": list(issues.values("status__name").annotate(count=Count("id")).order_by("status__name")),
        "by_priority": list(issues.values("priority").annotate(count=Count("id")).order_by("-priority")),
        "projects": list(
            issues.values("project__key", "project__name").annotate(count=Count("id")).order_by("project__key")
        ),
    }


def build_burndown(report):
    """Remaining work per day, worked out from when each issue currently in the sprint was resolved."""
    sprint = report.sprint
    if sprint is None:
        raise ValueError("The sprint for this report was deleted.")
    if not sprint.start_date:
        raise ValueError("This sprint has no start date.")
    today = timezone.localdate()
    start = sprint.start_date
    end = sprint.end_date or (sprint.completed_at.date() if sprint.completed_at else max(today, start))
    issues = list(sprint.issues.values("story_points", "resolved_at"))
    total_points = sum(i["story_points"] or 0 for i in issues)
    span = max((end - start).days, 1)

    days = []
    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        open_issues = [i for i in issues if not i["resolved_at"] or i["resolved_at"].date() > day]
        future = day > today
        days.append({
            "date": day.isoformat(),
            "ideal_points": round(total_points * (1 - offset / span), 1),
            "remaining_points": None if future else sum(i["story_points"] or 0 for i in open_issues),
            "remaining_issues": None if future else len(open_issues),
        })
    return {
        "sprint": sprint.name,
        "state": sprint.state,
        "goal": sprint.goal,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "total_points": total_points,
        "total_issues": len(issues),
        "completed_points": sum(i["story_points"] or 0 for i in issues if i["resolved_at"]),
        "completed_issues": sum(1 for i in issues if i["resolved_at"]),
        "days": days,
    }


def build_velocity(report):
    """Points delivered per closed sprint, oldest first."""
    project = report.project
    if project is None:
        raise ValueError("The project for this report was deleted.")
    done = Q(issues__status__category=DONE)
    latest = (
        Sprint.objects.filter(project=project, state=Sprint.State.CLOSED)
        .annotate(
            completed_points=Coalesce(Sum("issues__story_points", filter=done), Value(0), output_field=IntegerField()),
            completed_issues=Count("issues", filter=done, distinct=True),
            open_issues=Count("issues", filter=Q(issues__isnull=False) & ~done, distinct=True),
        )
        .order_by("-start_date", "-id")[:VELOCITY_SPRINTS]
    )
    sprints = [
        {
            "name": sprint.name,
            "start_date": sprint.start_date.isoformat() if sprint.start_date else None,
            "end_date": sprint.end_date.isoformat() if sprint.end_date else None,
            "completed_points": sprint.completed_points,
            "completed_issues": sprint.completed_issues,
            "open_issues": sprint.open_issues,
        }
        for sprint in reversed(latest)
    ]
    points = [s["completed_points"] for s in sprints]
    return {
        "project": project.name,
        "sprints": sprints,
        "average_points": round(sum(points) / len(points), 1) if points else 0,
    }


BUILDERS = {"workspace_summary": build_summary, "sprint_burndown": build_burndown, "velocity": build_velocity}


def csv_rows(report):
    data = report.data
    if report.report_type == "sprint_burndown":
        rows = [["Date", "Ideal points", "Remaining points", "Remaining issues"]]
        rows += [[d["date"], d["ideal_points"], d["remaining_points"], d["remaining_issues"]] for d in data["days"]]
        return rows
    if report.report_type == "velocity":
        rows = [["Sprint", "Start", "End", "Completed points", "Completed issues", "Issues left open"]]
        rows += [
            [s["name"], s["start_date"], s["end_date"], s["completed_points"], s["completed_issues"], s["open_issues"]]
            for s in data["sprints"]
        ]
        return rows
    rows = [["Section", "Item", "Issues"], ["Total", "All issues", data["issue_count"]]]
    rows += [["Status", r["status__name"], r["count"]] for r in data["by_status"]]
    rows += [["Priority", dict(Issue.Priority.choices).get(r["priority"]), r["count"]] for r in data["by_priority"]]
    rows += [["Project", f"{r['project__key']} {r['project__name']}", r["count"]] for r in data["projects"]]
    return rows


def csv_safe(value):
    """Stop spreadsheet apps treating user text such as =HYPERLINK(...) as a formula."""
    if value is None:
        return ""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return f"'{value}"
    return value
