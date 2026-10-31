"""
Seed realistic multi-tenant demo data with Faker.

    python manage.py seed_demo            # create demo data (skips workspaces that already exist)
    python manage.py seed_demo --reset    # wipe the demo tenants/users first, then recreate
"""
import random
from datetime import datetime, time, timedelta

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone
from faker import Faker

from apps.accounts.models import User
from apps.issues.models import Issue, Label
from apps.projects.models import Sprint, WorkflowStatus
from apps.projects.services import create_project
from apps.tenants.models import Membership, Workspace
from apps.tenants.services import create_workspace

DEMO_PASSWORD = "Demo@1234"
SUPERUSER_EMAIL = "admin@flowboard.test"
SHARED_USER_EMAIL = "alex@flowboard.test"  # member of two workspaces -> demos the workspace switcher

COMPANIES = [
    {
        "name": "Acme Corp", "slug": "acme", "domain": "acme.test", "plan": Workspace.Plan.PRO,
        "projects": [
            ("Website Revamp", "WEB", "#6366f1"),
            ("Mobile App", "MOB", "#ec4899"),
            ("Platform API", "API", "#14b8a6"),
        ],
    },
    {
        "name": "Globex Industries", "slug": "globex", "domain": "globex.test", "plan": Workspace.Plan.FREE,
        "projects": [
            ("Customer Portal", "CP", "#f97316"),
            ("Data Pipeline", "DATA", "#3b82f6"),
        ],
    },
    {
        "name": "Initech Labs", "slug": "initech", "domain": "initech.test", "plan": Workspace.Plan.ENTERPRISE,
        "projects": [
            ("Payments Gateway", "PAY", "#22c55e"),
            ("Internal Tools", "OPS", "#8b5cf6"),
        ],
    },
]

LABELS = [
    ("frontend", "#3b82f6"), ("backend", "#22c55e"), ("ux", "#ec4899"), ("tech-debt", "#f97316"),
    ("security", "#ef4444"), ("performance", "#eab308"), ("devops", "#14b8a6"),
]

EPICS = [
    "User authentication overhaul", "Checkout redesign", "Notifications platform", "Reporting & analytics",
    "Onboarding experience", "Performance hardening", "Billing & subscriptions", "Accessibility compliance",
]

VERBS = {
    Issue.IssueType.STORY: ["As a user I can", "Allow admins to", "Let customers", "Enable teams to"],
    Issue.IssueType.TASK: ["Implement", "Refactor", "Add", "Update", "Migrate", "Document", "Write tests for"],
    Issue.IssueType.BUG: ["Fix", "Crash in", "Wrong totals in", "Timeout on", "Broken layout in", "Race condition in"],
}
STORY_OBJECTS = [
    "reset my password via email", "export reports to CSV", "invite teammates by link", "filter issues by label",
    "switch to dark mode", "upload profile avatars", "see a burndown chart", "pin favourite projects",
    "receive Slack notifications", "bulk-edit issues", "log in with Google", "schedule recurring reports",
]
THINGS = [
    "login flow", "checkout page", "notification service", "search API", "user profile page", "billing webhook",
    "dashboard charts", "CSV export", "onboarding wizard", "rate limiter", "file upload handler",
    "password reset email", "audit trail", "Kanban drag & drop", "session refresh", "invoice PDF generator",
    "permissions middleware", "image thumbnailer", "settings page", "GraphQL gateway",
]
SUFFIXES = ["", "", "", " on Safari", " for mobile", " in admin panel", " for enterprise plan", " (v2)", " under load"]

ROLES_PLAN = [Membership.Role.ADMIN, Membership.Role.MEMBER, Membership.Role.MEMBER,
              Membership.Role.MEMBER, Membership.Role.MEMBER, Membership.Role.VIEWER]


class Command(BaseCommand):
    help = "Seed demo workspaces, users, projects, sprints and issues."

    def add_arguments(self, parser):
        parser.add_argument("--reset", action="store_true", help="Delete existing demo data first.")
        parser.add_argument("--issues", type=int, default=45, help="Approximate issues per project.")
        parser.add_argument("--seed", type=int, default=42)

    def handle(self, *args, reset, issues, seed, **options):
        random.seed(seed)
        Faker.seed(seed)
        self.fake = Faker()
        self.issues_per_project = issues

        if reset:
            self._reset()

        with transaction.atomic():
            self._ensure_superuser()
            shared_user = self._user(SHARED_USER_EMAIL, "Alex", "Rivera", "Consultant")
            for index, company in enumerate(COMPANIES):
                if Workspace.objects.filter(slug=company["slug"]).exists():
                    self.stdout.write(f"  - {company['name']} already exists, skipping (use --reset)")
                    continue
                self._seed_company(company, shared_user if index < 2 else None)

        self._print_summary()

    # ------------------------------------------------------------------ setup

    def _reset(self):
        slugs = [c["slug"] for c in COMPANIES]
        domains = [c["domain"] for c in COMPANIES]
        Workspace.objects.filter(slug__in=slugs).delete()
        for domain in domains:
            User.objects.filter(email__endswith=f"@{domain}").delete()
        User.objects.filter(email=SHARED_USER_EMAIL).delete()
        self.stdout.write(self.style.WARNING("Demo data removed."))

    def _ensure_superuser(self):
        if not User.objects.filter(email=SUPERUSER_EMAIL).exists():
            User.objects.create_superuser(SUPERUSER_EMAIL, DEMO_PASSWORD, first_name="Platform", last_name="Admin")

    def _user(self, email, first, last, title=""):
        user, created = User.objects.get_or_create(
            email=email, defaults={"first_name": first, "last_name": last, "job_title": title}
        )
        if created:
            user.set_password(DEMO_PASSWORD)
            user.save()
        return user

    # ---------------------------------------------------------------- company

    def _seed_company(self, company, shared_user):
        domain = company["domain"]
        owner = self._user(f"owner@{domain}", self.fake.first_name(), self.fake.last_name(), "CTO")
        workspace = create_workspace(name=company["name"], owner=owner, plan=company["plan"], slug=company["slug"])

        team = [owner]
        for role in ROLES_PLAN:
            first, last = self.fake.first_name(), self.fake.last_name()
            title = {"admin": "Engineering Manager", "viewer": "Stakeholder"}.get(role, self.fake.job()[:100])
            email = f"{role}@{domain}" if role != Membership.Role.MEMBER else f"{first.lower()}.{last.lower()}@{domain}"
            user = self._user(email, first, last, title)
            _, created = Membership.objects.get_or_create(workspace=workspace, user=user, defaults={"role": role})
            if created and role != Membership.Role.VIEWER:
                team.append(user)
        if shared_user:
            Membership.objects.create(workspace=workspace, user=shared_user, role=Membership.Role.MEMBER)
            team.append(shared_user)

        labels = [Label.objects.create(workspace=workspace, name=n, color=c) for n, c in LABELS]

        for name, key, color in company["projects"]:
            project = create_project(
                workspace=workspace, name=name, key=key, color=color, created_by=owner,
                lead=random.choice(team), description=self.fake.paragraph(nb_sentences=3),
            )
            self._seed_project(project, team, labels)

        self.stdout.write(self.style.SUCCESS(f"  + {company['name']} ({workspace.slug})"))

    # ---------------------------------------------------------------- project

    def _seed_project(self, project, team, labels):
        statuses = list(project.workflow.statuses.all())
        by_category = {}
        for status in statuses:
            by_category.setdefault(status.category, []).append(status)

        today = timezone.localdate()
        sprint_defs = [
            ("Sprint 1", Sprint.State.CLOSED, -42),
            ("Sprint 2", Sprint.State.CLOSED, -28),
            ("Sprint 3", Sprint.State.ACTIVE, -5),
            ("Sprint 4", Sprint.State.PLANNED, 9),
        ]
        sprints = []
        for name, state, offset in sprint_defs:
            start = today + timedelta(days=offset)
            sprints.append(Sprint.objects.create(
                project=project, name=f"{project.key} {name}", state=state, start_date=start,
                end_date=start + timedelta(days=13), goal=self.fake.sentence(nb_words=8),
                completed_at=timezone.now() + timedelta(days=offset + 13) if state == Sprint.State.CLOSED else None,
            ))

        epics = [
            Issue.objects.create(
                project=project, title=title, issue_type=Issue.IssueType.EPIC,
                status=random.choice(by_category[WorkflowStatus.Category.IN_PROGRESS]),
                reporter=random.choice(team), priority=Issue.Priority.HIGH,
                description=self._description(),
            )
            for title in random.sample(EPICS, 3)
        ]

        for _ in range(self.issues_per_project):
            sprint = random.choices(sprints + [None], weights=[2, 2, 4, 2, 3])[0]
            issue_type = random.choices(
                [Issue.IssueType.STORY, Issue.IssueType.TASK, Issue.IssueType.BUG], weights=[4, 4, 2]
            )[0]
            status = self._status_for(sprint, by_category)
            issue = Issue.objects.create(
                project=project,
                title=self._title(issue_type),
                issue_type=issue_type,
                description=self._description(),
                priority=random.choices(list(Issue.Priority.values), weights=[1, 3, 5, 3, 1])[0],
                status=status,
                sprint=sprint,
                parent=random.choice(epics) if issue_type == Issue.IssueType.STORY and random.random() < 0.7 else None,
                assignee=random.choice(team) if random.random() < 0.85 else None,
                reporter=random.choice(team),
                story_points=random.choice([1, 2, 3, 5, 8, 13]) if issue_type != Issue.IssueType.BUG else None,
                due_date=today + timedelta(days=random.randint(-10, 30)) if random.random() < 0.35 else None,
            )
            issue.labels.set(random.sample(labels, k=random.randint(0, 2)))
            self._backdate(issue, sprint)

    def _backdate(self, issue, sprint):
        """Give the issue a believable history so trend charts and 'done this week' look real."""
        now = timezone.now()
        if sprint and sprint.start_date:
            sprint_start = timezone.make_aware(datetime.combine(sprint.start_date, time(9)))
            created = sprint_start - timedelta(days=random.randint(1, 10), hours=random.randint(0, 8))
        else:
            sprint_start = None
            created = now - timedelta(days=random.randint(1, 30), hours=random.randint(0, 23))
        history = {"created_at": created, "updated_at": created + (now - created) * random.random()}
        if issue.resolved_at:
            window_start = max(created, sprint_start) if sprint_start else created
            window_end = now
            if sprint and sprint.end_date:
                window_end = min(now, timezone.make_aware(datetime.combine(sprint.end_date, time(18))))
            resolved = window_start + (window_end - window_start) * random.random()
            history.update(resolved_at=resolved, updated_at=resolved)
        Issue.objects.filter(pk=issue.pk).update(**history)

    def _status_for(self, sprint, by_category):
        C = WorkflowStatus.Category
        if sprint is None or sprint.state == Sprint.State.PLANNED:
            category = C.TODO
        elif sprint.state == Sprint.State.CLOSED:
            category = random.choices([C.DONE, C.IN_PROGRESS], weights=[9, 1])[0]
        else:
            category = random.choices([C.TODO, C.IN_PROGRESS, C.DONE], weights=[3, 4, 3])[0]
        return random.choice(by_category[category])

    def _title(self, issue_type):
        verb = random.choice(VERBS[issue_type])
        if issue_type == Issue.IssueType.STORY:
            return f"{verb} {random.choice(STORY_OBJECTS)}"
        return f"{verb} {random.choice(THINGS)}{random.choice(SUFFIXES)}"

    def _description(self):
        criteria = "\n".join(f"- {self.fake.sentence(nb_words=7)}" for _ in range(random.randint(2, 4)))
        return f"{self.fake.paragraph(nb_sentences=3)}\n\n**Acceptance criteria**\n{criteria}"

    # ---------------------------------------------------------------- summary

    def _print_summary(self):
        self.stdout.write("")
        self.stdout.write(self.style.MIGRATE_HEADING(f"Demo logins (password for all: {DEMO_PASSWORD})"))
        self.stdout.write(f"  Platform superuser (Django admin): {SUPERUSER_EMAIL}")
        self.stdout.write(f"  Multi-workspace user:              {SHARED_USER_EMAIL}  (Acme + Globex)")
        for company in COMPANIES:
            workspace = Workspace.objects.filter(slug=company["slug"]).first()
            if not workspace:
                continue
            issues = Issue.objects.for_workspace(workspace).count()
            self.stdout.write(
                f"  {company['name']:<20} owner@{company['domain']:<14} admin@{company['domain']:<14}"
                f" viewer@{company['domain']:<14} [{workspace.plan}, {issues} issues]"
            )
