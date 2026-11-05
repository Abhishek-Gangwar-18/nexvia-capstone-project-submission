# FlowBoard architecture

How FlowBoard is put together: the moving parts, how tenants are kept apart, the data model, and
the reasoning behind the main design decisions. For setup see the [README](../README.md); for
exercising the API see [API_TEST.md](API_TEST.md).

> **Status:** all seven phases are implemented: tenancy + models, REST API, React UI, workflows and
> collaboration, background jobs, Stripe billing, and Docker + GitHub Actions. See [section 12](#12-roadmap).

- [1. System overview](#1-system-overview)
- [2. Tech stack](#2-tech-stack)
- [3. Repository layout](#3-repository-layout)
- [4. Multi-tenancy](#4-multi-tenancy)
- [5. Data model](#5-data-model)
- [6. Domain rules](#6-domain-rules)
- [7. Authentication and authorization](#7-authentication-and-authorization)
- [8. Backend design](#8-backend-design)
- [8a. Billing (Stripe)](#8a-billing-stripe)
- [9. Frontend design](#9-frontend-design)
- [10. Local environment](#10-local-environment)
- [10a. Containers and deployment](#10a-containers-and-deployment)
- [11. Testing strategy](#11-testing-strategy)
- [12. Roadmap](#12-roadmap)

---

## 1. System overview

```mermaid
flowchart LR
    subgraph Browser
        SPA["React SPA<br/>(TypeScript, TanStack Query, dnd-kit)"]
    end
    subgraph Dev["nginx :8080 (Docker) / Vite :5173 (dev)"]
        Proxy["static SPA + /api proxy"]
    end
    subgraph Backend["Django on gunicorn :8000"]
        MW["TenantMiddleware"]
        DRF["DRF viewsets<br/>WorkspaceScopedMixin"]
        ORM["TenantModel / TenantQuerySet"]
    end
    PG[("PostgreSQL 16<br/>shared schema")]
    Redis[("Redis 7")]
    Worker["Celery worker + beat"]
    Hooks["Customer webhook URLs"]
    Mail["Email (console or SMTP)"]
    Stripe["Stripe Billing<br/>(Checkout, Portal, webhooks)"]

    SPA -- "JWT + X-Workspace" --> Proxy --> MW --> DRF --> ORM --> PG
    DRF -. "enqueue jobs" .-> Redis -.-> Worker
    Worker --> PG
    Worker --> Hooks
    Worker --> Mail
    DRF -- "checkout / portal / sync" --> Stripe
    Stripe -- "signed webhook" --> Proxy
```

- The browser only ever talks to **one origin**. In Docker, nginx serves the built SPA and proxies `/api`,
  `/admin` and `/static` to gunicorn; in dev, Vite proxies `/api` to Django. Either way no CORS is
  involved. CORS is still configured (`CORS_ALLOWED_ORIGINS`, with `x-workspace` allowed) for setups
  where the SPA is served from somewhere else.
- Django is a **pure JSON API**. It renders no HTML except the admin and the Swagger UI.
- Redis (host port 6380) is the Celery broker. Task outcomes are stored on domain rows, so there is no result
  backend. If Redis is down, queuing fails after a few seconds, the request still succeeds, and the failure is
  logged or shown on the report or webhook delivery.

---

## 2. Tech stack

| Layer | Technology | Version | Why |
|---|---|---|---|
| API | Django + Django REST Framework | 5.2 LTS · 3.18 | Mature ORM/migrations, serializers, permission system |
| Auth | djangorestframework-simplejwt (+ token blacklist) | 5.5 | Stateless JWT for an SPA; rotation + revocation |
| Filtering | django-filter | 26.2 | Declarative query-param filters |
| API docs | drf-spectacular | 0.30 | OpenAPI 3 schema + Swagger UI from the code |
| Database | PostgreSQL (psycopg 3) | 16 | Partial unique indexes, check constraints, row locks |
| Broker | Redis | 7 | Celery broker |
| Background jobs | Celery + beat | 5 | Webhooks, notifications, reports, email, daily jobs |
| TLS trust | certifi | current | Consistent CA list for HTTPS webhooks, including on Windows |
| Frontend | React + TypeScript | 19.3 · 5.9 | Strict typing across ~50 modules |
| Build | Vite + pnpm | 7.3 · 12.16 | Fast dev server with proxy; strict, reproducible installs |
| Routing | React Router (library mode) | 7.18 | Nested layouts (workspace → project → tab) |
| Server state | TanStack Query | 5.105 | Caching, invalidation, optimistic updates |
| Client state | Zustand (persist) | 5.0 | Auth tokens + UI prefs in localStorage |
| UI | Tailwind CSS v4, Headless UI, lucide-react | 4.3 · 2.2 · 1.x | Accessible primitives, design tokens, dark mode |
| Drag & drop | dnd-kit (core + sortable) | 6.3 · 10.0 | Multi-container sortable lists, keyboard support |
| Charts | Recharts | 3.10 | Dashboard charts |
| Billing | Stripe Billing (`stripe` Python SDK) | 16 | Checkout, Customer Portal, signed webhooks; test mode |
| App server | gunicorn + whitenoise | 23 · 6 | WSGI server; whitenoise serves admin/Swagger static files in the image |
| Web server | nginx | 1.29 | Serves the SPA, proxies `/api`, `/admin`, `/static` |
| Containers | Docker + Docker Compose | n/a | Full stack locally (`docker-compose.yml`) and in production (`docker-compose.prod.yml`) |
| CI/CD | GitHub Actions + GHCR | n/a | Tests, builds, smoke test, image push, SSH deploy |

---

## 3. Repository layout

```
.
├── docker-compose.yml          full stack locally, or just db + redis for dev
├── docker-compose.prod.yml     production stack from the GHCR images
├── .env.example                every setting, with dev defaults (copy to .env)
├── .gitattributes              keeps LF endings for shell scripts / Dockerfiles
├── .github/workflows/ci.yml    CI/CD pipeline
├── scripts/smoke_test.py       end-to-end checks against a running stack
├── README.md
├── docs/
│   ├── API_TEST.md             manual + automated API testing guide
│   └── ARCHITECTURE.md         this file
├── backend/
│   ├── manage.py · requirements.txt · pytest.ini · conftest.py
│   ├── Dockerfile · docker-entrypoint.sh · .dockerignore
│   ├── config/                 settings.py (env-driven), urls.py, wsgi/asgi, celery.py
│   └── apps/
│       ├── core/               tenancy primitives, API base classes, seed command, tests
│       ├── accounts/           custom User (email login), auth endpoints
│       ├── tenants/            Workspace, Membership, Invitation
│       ├── projects/           Project, Workflow, WorkflowStatus, WorkflowTransition, Board, Sprint
│       ├── issues/             Issue, Label, comments, attachments, AuditLog, move service, filters, dashboard
│       ├── automation/         webhooks, notifications, reports, email, Celery tasks and templates
│       └── billing/            plans, limits, Subscription, Stripe services + webhook, stripe_setup command
└── frontend/
    ├── package.json · pnpm-lock.yaml · pnpm-workspace.yaml · vite.config.ts
    ├── Dockerfile · nginx.conf.template · .dockerignore
    └── src/
        ├── main.tsx · App.tsx · router.tsx · index.css · types.ts
        ├── lib/                api client, query client, utils, constants
        ├── store/              zustand: auth, ui
        ├── hooks/              queries.ts (all API hooks), useWorkspace, useSortableContainers
        ├── components/
        │   ├── ui/             Button, Input, Modal/Drawer, Select, Dropdown, Avatar…
        │   ├── layout/         WorkspaceLayout, Sidebar, Topbar, CommandPalette…
        │   ├── issues/         IssueCard, IssueDrawer, CreateIssueModal, IssueMeta
        │   ├── board/          KanbanColumn, BoardFilters
        │   ├── sprints/        sprint create/start/complete modals
        │   └── settings/       webhook management
        └── pages/              auth/, project/ (Board, Backlog, Workflow), Dashboard, Issues, Reports, AuditLog, Billing, Members…
```

### Backend apps

| App | Owns | Key modules |
|---|---|---|
| `core` | The tenancy framework that every other app builds on | `models.py` (TenantModel, TenantQuerySet), `context.py` (ContextVar), `middleware.py`, `api.py` (WorkspaceScopedMixin, TenantModelViewSet), `permissions.py`, `fields.py`, `exceptions.py`, `pagination.py`, `schema.py`, `management/commands/seed_demo.py` |
| `accounts` | Identity | `User` (email is the username), register/login/refresh/logout/me/change-password |
| `tenants` | The tenant itself | `Workspace`, `Membership` (role), `Invitation`; services `create_workspace`, `accept_invitation` |
| `projects` | Containers of work | `Project`, `Workflow` + statuses + transitions, `Board`, `Sprint`; `services.create_project` scaffolds a workflow and a board |
| `issues` | Work items and history | `Issue`, `Label`, `IssueComment`, `IssueAttachment`, `AuditLog`; `services.move_issue` (ranking), `activity.py` (`record_issue_event`, `record_event`), `dashboard.DashboardView`; `signals.py` guards labels, removes attachment files, releases a removed member's work |
| `automation` | Background work | `WebhookEndpoint`, `WebhookDelivery`, `Notification`, `WorkspaceReport`; `tasks.py`, `queue.py` (`enqueue`), `reports.py`, `emails.py`, `templates/email/` |
| `billing` | Plans and payments | `plans.py` (catalog), `limits.py` (402 checks), `Subscription`, `StripeEvent`; `services.py` (Checkout, Portal, sync, webhook handling), `management/commands/stripe_setup.py` |

---

## 4. Multi-tenancy

### 4.1 Strategy: shared database, shared schema, `workspace_id` on every row

| Option | Isolation | Ops cost | Verdict |
|---|---|---|---|
| Database per tenant | strongest | a DB + migration run per customer | overkill for this product |
| Schema per tenant (`django-tenants`) | strong | N schemas to migrate; cross-tenant reporting is hard | heavier than needed |
| **Shared schema + `workspace_id`** | enforced in code | one schema, one migration path, one pool | ✅ chosen |

The weakness of a shared schema is that one forgotten `filter(workspace=…)` leaks data. FlowBoard's
answer is to make the safe path the **only** path, through three independent layers.

### 4.2 The three layers

| Layer | Where | Guarantee |
|---|---|---|
| **1. Request** | `core/api.py` `WorkspaceScopedMixin.check_permissions` | Runs after JWT authentication and before permission checks. Reads `X-Workspace`, loads the caller's `Membership` for that slug, and fails with **404** if there isn't one (the same response as for a workspace that doesn't exist, so tenants can't be probed). It binds `request.workspace`, `request.membership` and the ContextVar. |
| **2. Query** | `core/models.py` `TenantQuerySet` · `core/fields.py` | `TenantModelViewSet.get_queryset()` always goes through `for_workspace(request.workspace)`, so other tenants' rows are unreachable: they give a 404, never a 403. Serializer relations use `TenantPrimaryKeyRelatedField` and `WorkspaceMemberField`, so a foreign id in a payload is simply "does not exist". `.current()` raises `TenantContextMissing` when no workspace is bound (**fail closed**). |
| **3. Write** | `TenantModel.save()` · `issues/signals.py` | Every save stamps `workspace` (from `tenant_parent` such as `project`, or from the bound context; with neither it refuses to save). It then walks every FK to another `TenantModel` and raises if one points at a different workspace. M2M label writes are guarded by an `m2m_changed` receiver. Issue assignee/reporter must be members. |

Layers 2 and 3 overlap on purpose. Even code that bypasses the API (admin, shell, the seed command,
future Celery tasks) can't create a cross-tenant reference.

### 4.3 Request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant M as TenantMiddleware
    participant V as WorkspaceScopedMixin (DRF view)
    participant Q as TenantQuerySet
    participant DB as PostgreSQL

    C->>M: GET /api/issues/?sprint=active<br/>Authorization: Bearer …, X-Workspace: acme
    M->>M: reset tenant ContextVar (no leakage between requests)
    M->>V: dispatch
    V->>V: JWT authentication → request.user
    V->>DB: Membership where user = me and workspace.slug = "acme"
    alt not a member / no such workspace
        V-->>C: 404 Workspace not found.
    else member
        V->>V: bind request.workspace, request.membership, ContextVar
        V->>V: HasWorkspaceRole: role ≥ required_roles[action]?
        alt role too low
            V-->>C: 403
        else allowed
            V->>Q: Issue.objects.for_workspace(acme).filter(sprint__state="active")
            Q->>DB: SELECT … WHERE workspace_id = 7 AND …
            DB-->>V: rows
            V-->>C: 200 JSON
        end
    end
    M->>M: restore ContextVar
```

### 4.4 Why a ContextVar, and why 404

- **ContextVar, not a thread-local:** it's correct under threads, async views and Celery workers.
  The middleware resets it at the start of a request and restores it at the end, so a workspace can
  never bleed into the next request on the same worker. Background jobs will bind it explicitly with
  `with workspace_context(ws):`.
- **404 for foreign tenants:** a 403 would confirm that a workspace or issue exists. To a non-member,
  every other tenant's data is indistinguishable from data that doesn't exist.

---

## 5. Data model

```mermaid
erDiagram
    USER ||--o{ MEMBERSHIP : "has"
    WORKSPACE ||--o{ MEMBERSHIP : "has"
    WORKSPACE ||--o{ INVITATION : "sends"
    WORKSPACE ||--o{ PROJECT : "owns"
    WORKSPACE ||--o{ LABEL : "owns"
    PROJECT ||--|| WORKFLOW : "has"
    WORKFLOW ||--o{ WORKFLOW_STATUS : "orders"
    WORKFLOW ||--o{ WORKFLOW_TRANSITION : "allows"
    PROJECT ||--o{ BOARD : "shown on"
    PROJECT ||--o{ SPRINT : "plans"
    PROJECT ||--o{ ISSUE : "contains"
    WORKFLOW_STATUS ||--o{ ISSUE : "status of"
    SPRINT |o--o{ ISSUE : "scheduled in"
    ISSUE |o--o{ ISSUE : "parent (epic / sub-task)"
    ISSUE }o--o{ LABEL : "tagged"
    USER |o--o{ ISSUE : "assignee / reporter"
    ISSUE ||--o{ ISSUE_COMMENT : "has"
    ISSUE ||--o{ ISSUE_ATTACHMENT : "has"
    WORKSPACE ||--o{ AUDIT_LOG : "records"
    WORKSPACE ||--o{ WEBHOOK_ENDPOINT : "owns"
    WEBHOOK_ENDPOINT ||--o{ WEBHOOK_DELIVERY : "logs"
    USER ||--o{ NOTIFICATION : "receives"
    WORKSPACE ||--o{ WORKSPACE_REPORT : "owns"
    WORKSPACE ||--o| SUBSCRIPTION : "billed through"

    WORKSPACE {
        string slug UK
        string plan "free | pro | enterprise"
        int owner_id FK
    }
    MEMBERSHIP {
        int workspace_id FK
        int user_id FK
        string role "owner | admin | member | viewer"
    }
    INVITATION {
        string email
        string role
        string token UK
        datetime expires_at
        datetime accepted_at
    }
    PROJECT {
        int workspace_id FK
        string key "unique per workspace"
        int issue_counter
        bool is_archived
    }
    WORKFLOW {
        int project_id FK
        bool enforce_transitions
    }
    WORKFLOW_STATUS {
        int workflow_id FK
        string name
        string category "todo | in_progress | done"
        int position
    }
    BOARD {
        int project_id FK
        string board_type "kanban | scrum"
        json wip_limits
    }
    SPRINT {
        int project_id FK
        string state "planned | active | closed"
        date start_date
        date end_date
    }
    ISSUE {
        int workspace_id FK
        string key "e.g. WEB-12"
        int number
        string issue_type
        int priority "1-5"
        float rank
        int story_points
        datetime resolved_at
    }
    LABEL {
        int workspace_id FK
        string name "unique per workspace"
        string color
    }
    SUBSCRIPTION {
        int workspace_id FK "one per workspace"
        string stripe_customer_id UK
        string stripe_subscription_id
        string status
        datetime current_period_end
        bool cancel_at_period_end
    }
```

`Subscription` and `StripeEvent` (processed webhook ids, unique) are platform-level billing records, not
`TenantModel`s: Stripe webhooks arrive with no workspace context and are matched by customer id.

Every model below `WORKSPACE` inherits `TenantModel`, so each has its own `workspace_id` column,
even where it could be inferred through a parent. That denormalisation is deliberate: every tenant
query is a single indexed `WHERE workspace_id = ?` with no joins.

### Constraints enforced by PostgreSQL

| Constraint | Rule |
|---|---|
| `unique_membership` | one membership per (workspace, user) |
| `unique_project_key_per_workspace` | `WEB` can exist in many workspaces, once per workspace |
| `unique_issue_number_per_project`, `unique_issue_key_per_workspace` | issue keys never collide |
| `one_active_sprint_per_project` | **partial** unique index on `project` where `state = 'active'` |
| `sprint_end_after_start` | check constraint |
| `unique_status_name_per_workflow`, `unique_transition`, `transition_not_self` | workflow integrity |
| `unique_label_per_workspace` | label names per tenant |
| indexes `(workspace, status)`, `(workspace, sprint)`, `(workspace, assignee)`, `rank` | board, backlog and "my issues" queries |

---

## 6. Domain rules

| Rule | Implementation |
|---|---|
| **Issue keys** (`WEB-1`, `WEB-2`…) | `Project.allocate_issue_number()` runs `UPDATE … SET issue_counter = issue_counter + 1` inside the issue's transaction. The row lock serialises concurrent creators, and a failed save rolls the counter back, so no numbers are burned. Numbers of deleted issues are never reused. |
| **Ordering / drag-and-drop** | `Issue.rank` is a float. A move sends `prev_id` / `next_id` and the server sets `rank = (prev + next) / 2` (or ±1024 at either end). When two neighbours get closer than 1e-6 apart, `rebalance_ranks()` re-spaces the whole project in one `bulk_update`. Moving a card writes 1 row, not N. |
| **Resolution** | `resolved_at` is set when an issue enters a `done`-category status and cleared when it leaves one. Dashboards and sprint stats rely on it. |
| **Workflows** | Each project owns one `Workflow` with ordered `WorkflowStatus` rows (category todo/in_progress/done). With `enforce_transitions = False` (the default) any move is allowed; when it's True, only explicit `WorkflowTransition` rows are. This is checked in both the serializer (PATCH) and `move_issue`, and the board dims blocked columns during a drag. A status in use can't be removed or change category. |
| **Archived projects** | Their issues are read-only: PATCH, move and create return 400. |
| **Removed members** | Their assignments and project lead roles are cleared. History such as reporter, comment author and audit actor is kept, and membership is only validated when those rows are created, so old records stay editable. |
| **Audit log** | `AuditLog` stores labels as text and uses `SET_NULL` on project, so entries outlive what they describe. Reordering inside a column is not logged. Only issue events trigger webhooks and notifications. |
| **Sprints** | `planned → active → closed`. Only one is active per project (DB-enforced). Completing a sprint moves unfinished issues to a planned sprint or the backlog in one transaction. Closed sprints are read-only and can't receive issues. |
| **Hierarchy** | Story/task/bug → epic parent. Only `subtask` may have a non-epic parent. A parent must be in the same project and can't be the issue itself. |
| **Deletion** | `Issue.status` uses `on_delete=RESTRICT`: a status in use can't be deleted on its own, but deleting a project or workspace cascades cleanly. (`PROTECT` would block those cascades.) |
| **Project scaffolding** | `create_project()` creates the project, a 4-status workflow (To Do, In Progress, In Review, Done) and a board in one transaction. |

---

## 7. Authentication and authorization

### Tokens

| | Value | Notes |
|---|---|---|
| Access token | 30 min | `Authorization: Bearer …` |
| Refresh token | 7 days | rotated on every refresh; the old one is blacklisted (`token_blacklist` app) |
| Logout | blacklists the refresh token | the access token expires naturally |
| Brute-force protection | `ScopedRateThrottle` 20/min | on login and register |
| Passwords | Django validators | length, common, numeric, similarity |

### Roles

`owner > admin > member > viewer` (`Membership.ROLE_RANK`). Views declare only their exceptions:

```python
class ProjectViewSet(TenantModelViewSet):
    required_roles = {"create": Role.ADMIN, "update": Role.ADMIN, "partial_update": Role.ADMIN, "destroy": Role.ADMIN}
    # everything else: reads → VIEWER, writes → MEMBER (the default in core/permissions.py)
```

Object-level rules live in the view's `perform_*`: an issue can be deleted by its reporter or an admin;
the owner can't be removed or demoted; you can't change your own role; anyone may leave.

| Capability | Viewer | Member | Admin | Owner |
|---|:-:|:-:|:-:|:-:|
| Read the workspace | ✅ | ✅ | ✅ | ✅ |
| Issues, sprints, labels: create/edit/move | | ✅ | ✅ | ✅ |
| Delete an issue | | own | ✅ | ✅ |
| Projects, workflows, boards (WIP), webhooks, audit log, delete sprints/labels | | | ✅ | ✅ |
| Invitations, roles, removing members, renaming the workspace | | | ✅ | ✅ |
| See the plan and usage (`GET /billing/`) | ✅ | ✅ | ✅ | ✅ |
| Checkout, Customer Portal, sync; delete the workspace | | | | ✅ |

The frontend mirrors this ladder in `usePermissions()` and hides what the API would refuse. The API
stays the authority either way.

---

## 8. Backend design

### Background jobs

| Job | Trigger | Behaviour |
|---|---|---|
| `process_issue_event` | after commit of an issue event | creates webhook deliveries and notifications |
| `deliver_webhook` | per delivery | HMAC-SHA256 signature; 5 retries with backoff; blocked targets fail without retrying |
| `generate_workspace_report` | `POST /reports/` | stores JSON on the report, or `failed` with the reason |
| `send_notification_email`, `send_invitation_email` | on creation or resend | 3 retries on SMTP/network errors; never sends twice for a notification; honours the opt-out |
| `create_overdue_reminders`, `create_daily_digests` | beat, 08:00 and 08:05 UTC | one per person per day, enforced by a unique constraint |

**Webhook target safety:** outside `DEBUG`, targets must be HTTPS and every resolved address must be public. The
validated IP is pinned for the connection, so a DNS answer that changes afterwards (DNS rebinding) can't reach
internal services. TLS still verifies the original hostname. Redirects and proxy variables are ignored. With
`DEBUG=True`, HTTP and local targets are allowed for development.

**Email policy:** mentions, new assignments, overdue issues and digests are emailed. Routine updates stay in-app.

**Burndown limitation:** it is computed from the issues currently in the sprint and their `resolved_at`, because
sprint membership history isn't stored. Issues moved out earlier don't appear in past days.

### Conventions

| Concern | Approach |
|---|---|
| Settings | `config/settings.py` reads everything from env / `.env` (secret, debug, hosts, `DATABASE_URL`, `REDIS_URL`, `FRONTEND_URL`, CORS) |
| Base classes | `TenantModelViewSet` = workspace resolution + scoped queryset + `perform_create` stamping the workspace. Most viewsets only add a serializer and filters. |
| Services | Business operations with multiple writes live in `services.py` (`create_workspace`, `create_project`, `accept_invitation`, `move_issue`) inside transactions, so the API, admin, seed and future jobs share them |
| Lookups | Projects by `key`, issues by `key` (case-insensitive), everything else by id |
| Pagination | `OptionalPageNumberPagination`: a plain list unless `?page=` is sent, so small collections stay simple and big ones can page (max 500) |
| Errors | `core/exceptions.py` maps Django `ValidationError` (model/tenant guards) → 400 and `IntegrityError` → 409, so the API never 500s on bad input |
| Query efficiency | `select_related`/`prefetch_related` on every list; counts and story points are aggregated in SQL (`annotate`), and the dashboard is built from grouped queries |
| OpenAPI | drf-spectacular with a custom `TenantAutoSchema` that adds the `X-Workspace` header to every scoped endpoint; the schema builds with 0 warnings |
| Seed data | `seed_demo` (Faker, deterministic seed 42): 3 workspaces, 7 projects, ~336 issues, epics, labels, closed/active/planned sprints, believable created/resolved timelines. Idempotent, so the Docker image runs it on every start |

---

## 8a. Billing (Stripe)

**Single source of truth:** `Workspace.plan` (`free | pro | enterprise`) is the only value the limits read.
Stripe decides what a workspace has paid for; `apps/billing/services.apply_subscription()` copies that onto
`Subscription` and moves `Workspace.plan`, writing a `plan_changed` audit entry.

| Plan | Price | Projects | Members (+ pending invites) | File size | Stripe lookup key |
|---|---|---|---|---|---|
| Free | $0 | 3 | 5 | 10 MB | n/a |
| Pro | $29/mo | 20 | 50 | 25 MB | `flowboard_pro_monthly` |
| Enterprise | $99/mo | unlimited | unlimited | 100 MB | `flowboard_enterprise_monthly` |

The catalog lives in `billing/plans.py`. Prices are found in Stripe by **lookup key**, so no price ids are
configured anywhere; `python manage.py stripe_setup` (test keys only) creates the products, prices and
Customer Portal settings and is safe to run again.

```mermaid
sequenceDiagram
    autonumber
    participant O as Owner (SPA)
    participant API as Django
    participant S as Stripe
    O->>API: POST /billing/checkout/ {plan: "pro"}
    API->>S: create customer (once) + Checkout Session (subscription mode)
    API-->>O: {url}
    O->>S: pay on Stripe's hosted page (card never reaches FlowBoard)
    S-->>O: redirect /w/<slug>/billing?checkout=success
    O->>API: POST /billing/sync/ (re-reads the subscription from Stripe)
    S->>API: POST /api/billing/webhook/ (signed) checkout.session.completed, customer.subscription.*
    API->>S: retrieve subscription (events may arrive out of order)
    API->>API: apply_subscription → Workspace.plan, audit log
```

| Concern | Approach |
|---|---|
| **Limits** | `billing/limits.py`: `check_can_add_project` (create and un-archive), `check_can_add_member` (invitations; pending invites count), `check_file_size` (attachments). They raise **402** `{"code": "plan_limit_reached", "limit": …, "current_plan": …}`. Limits only block adding more; a downgraded workspace keeps everything it has |
| **Webhook security** | `StripeWebhookView` has no user auth; it verifies the `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET` (400 when invalid, 503 when not configured) |
| **Idempotency** | The event id is stored in `StripeEvent` (unique) in the same transaction as the work, so a repeated event is skipped and a failed one is retried by Stripe |
| **Event handling** | `checkout.session.completed` and `customer.subscription.*` re-read the subscription from Stripe and apply it; `invoice.payment_failed` notifies the owner (in-app + email). Paid statuses: `active`, `trialing`, `past_due`; ended (`canceled`, `unpaid`, `incomplete_expired`) → Free |
| **No webhooks locally** | `POST /billing/sync/` reads the latest subscription directly, so billing works on a laptop without `stripe listen` |
| **Workspace deletion** | The live subscription is cancelled first; a Stripe error blocks the delete instead of leaving a running charge |
| **Error hygiene** | Stripe errors are logged in full but returned as a generic 503, since Stripe messages can expose account details |
| **Roles** | Everyone can read `GET /billing/` (plan, usage, `can_manage`); Checkout, Portal and Sync are owner-only |

The frontend `BillingPage` shows the plan, usage bars and plan cards; it syncs after returning from
Checkout and shows a toast. A global 402 handler (`lib/queryClient.ts`) turns any limit error into a toast
with an **Upgrade** link.

---

## 9. Frontend design

### 9.1 Routing

```
/login · /register · /invite/:token                     public
RequireAuth
├── /                    → last workspace's dashboard (or /onboarding)
├── /onboarding          create the first workspace
└── /w/:slug             WorkspaceLayout: sidebar, topbar, drawer, modals, palette
    ├── dashboard
    ├── projects
    ├── projects/:key    ProjectLayout: header + tabs, passes the project via <Outlet context>
    │   ├── board        Kanban (scrum → active sprint, kanban → all)
    │   ├── backlog      sprints + backlog
    │   ├── issues       table scoped to the project
    │   └── workflow     statuses and transition rules
    ├── issues           table across all projects
    ├── reports          generate and view reports, CSV
    ├── audit            workspace history (admins)
    ├── billing          plan, usage, upgrade / manage billing (owner)
    ├── members · settings · profile
```

The **workspace slug lives in the URL**, so links are shareable, and the browser back button switches
workspaces correctly. The open issue lives in the query string (`?issue=WEB-12`), so the drawer is
deep-linkable from any page.

### 9.2 State

| Kind | Tool | Notes |
|---|---|---|
| Server data | TanStack Query | Every key is namespaced `["ws", slug, …]`: two workspaces never share cache entries, and switching tenants can't flash the other tenant's data |
| Auth | Zustand `useAuth` (persisted) | access, refresh, user |
| UI prefs | Zustand `useUI` (persisted: theme, sidebar, last workspace) | also drives the create-issue modal and the command palette |
| URL | React Router | workspace, project, tab, open issue |

All API access goes through `hooks/queries.ts`. `useWsApi()` binds the request helpers to the
current workspace and attaches `X-Workspace` per request instead of using global mutable state.
Mutations invalidate the related keys (issues, sprints, projects, dashboard). A global
`MutationCache.onError` turns any failure into a toast with the server's message.

### 9.3 API client

`lib/api.ts` (axios):

- attaches the access token to every request;
- on a 401 it runs a **single-flight refresh**: concurrent failing requests wait on one `/auth/refresh/`
  call. This matters because refresh tokens rotate, and two parallel refreshes would invalidate each
  other. The original requests are then replayed;
- if the refresh fails it clears the auth state, and `RequireAuth` redirects to `/login?next=…`.

### 9.4 Drag and drop

`hooks/useSortableContainers.ts` is a reusable multi-container sortable engine on dnd-kit. The board
(containers = statuses) and the backlog (containers = sprints + backlog) both use it.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant H as useSortableContainers
    participant M as useMoveIssue (TanStack mutation)
    participant QC as Query cache
    participant API as POST /issues/{key}/move/

    U->>H: drag card (PointerSensor, 6px activation, so a click still opens the drawer)
    H->>H: onDragOver: move the id between containers live
    U->>H: drop
    H->>H: onDragEnd: final index → prevId / nextId (skip if unchanged)
    H->>M: onDrop({ id, to, prevId, nextId })
    M->>QC: onMutate: cancel queries, snapshot, patch status/sprint + rank = between(prev, next)
    Note over QC: UI already shows the final position
    M->>API: { status | sprint, prev_id, next_id }
    alt rejected (e.g. disallowed transition)
        API-->>M: 400
        M->>QC: onError: restore snapshot (card snaps back) + toast
    else ok
        API-->>M: 200 issue
    end
    M->>QC: onSettled: invalidate issues / sprints / dashboard
```

Collision detection checks which column is under the pointer first, then picks the closest card
inside that column. That makes moving between columns feel natural and stops cards jumping between
neighbouring columns. A `DragOverlay` renders the lifted card, and the keyboard sensor makes the
board operable without a mouse.

### 9.5 UI system

- **Tailwind v4** with CSS-first tokens (`@theme` brand palette, animations) and class-based dark mode
  (`@custom-variant dark`). The theme is applied before first paint by an inline script in `index.html`,
  so there's no flash.
- **Headless UI** for accessible dialogs, drawers, listboxes, menus and the combobox palette. Small
  in-house primitives live in `components/ui/`.
- **Feedback:** optimistic updates, skeleton loaders, toasts (sonner), and empty states with next actions.
- **Productivity:** `Ctrl/⌘ K` palette (actions, projects, server-side issue search), `C` to create an
  issue, inline quick-add on columns and sprints, inline editing in the drawer.
- **Responsive:** collapsible sidebar on desktop and an off-canvas one on mobile. Board columns flex
  between 260 and 380 px.

---

## 10. Local environment

| Service | How it runs | Port |
|---|---|---|
| React (Vite) | `pnpm dev` | 5173 |
| Django | `python manage.py runserver` | 8000 |
| PostgreSQL 16 | `docker compose up -d db` | 5432 (`POSTGRES_HOST_PORT`) |
| Redis 7 | `docker compose up -d redis` | **6380** on the host (`REDIS_HOST_PORT`), so it doesn't clash with another Redis on 6379 |
| Celery worker | `python -m celery -A config worker --pool=solo -l info` | n/a |
| Celery beat | `python -m celery -A config beat -l info` | n/a |

| Env var | Default (dev) | Used for |
|---|---|---|
| `DJANGO_SECRET_KEY` | long dev placeholder | signing, including JWTs (HS256 needs ≥ 32 bytes) |
| `DJANGO_DEBUG` / `DJANGO_ALLOWED_HOSTS` | `True` / `localhost,127.0.0.1` | |
| `DATABASE_URL` | `postgres://flowboard:flowboard@localhost:5432/flowboard` | dj-database-url |
| `POSTGRES_DB/USER/PASSWORD/HOST_PORT` | `flowboard` ×3 / 5432 | docker compose |
| `REDIS_URL` / `REDIS_HOST_PORT` | `redis://localhost:6380/0` / 6380 | Celery broker |
| `EMAIL_BACKEND` | console backend | SMTP backend for real delivery |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `EMAIL_USE_TLS` | unset / 587 / TLS on | SMTP settings |
| `DEFAULT_FROM_EMAIL` | `FlowBoard <no-reply@flowboard.test>` | sender |
| `FRONTEND_URL` | `http://localhost:5173` | invitation links, Stripe success/cancel/return URLs |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | non-proxied setups |
| `VITE_API_PROXY` | `http://127.0.0.1:8000` | where Vite forwards `/api` |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | empty (billing disabled) | Stripe **test** keys |
| `STRIPE_WEBHOOK_SECRET` | empty | verifying webhook signatures (`whsec_…`) |
| `CSRF_TRUSTED_ORIGINS` | empty | admin logins through a proxy / HTTPS domain |
| `DJANGO_BEHIND_PROXY` | `False` | trust `X-Forwarded-Proto` from nginx |
| `DJANGO_SECURE_COOKIES` / `DJANGO_SECURE_SSL_REDIRECT` / `DJANGO_HSTS_SECONDS` | off / off / 0 | HTTPS hardening in production |
| `DJANGO_STATICFILES_STORAGE` | Django default | the image sets whitenoise's compressed manifest storage (and its middleware) |
| `DJANGO_MEDIA_ROOT` | `backend/media` | `/app/media` (a volume) in Docker |
| `DJANGO_LOG_LEVEL` | `INFO` | console logging |

Only Docker uses these: `APP_HTTP_PORT` (8080), `SEED_DEMO_DATA` (true locally, false in prod), `RUN_MIGRATIONS`,
`GUNICORN_WORKERS`, `CELERY_CONCURRENCY`, `BACKEND_IMAGE` / `FRONTEND_IMAGE`, and in production `IMAGE_PREFIX`,
`IMAGE_TAG`, `APP_DOMAIN`, `APP_SCHEME`.

pnpm 12 blocks dependency build scripts by default. The one that's needed (`esbuild`) is approved in
`frontend/pnpm-workspace.yaml` (`allowBuilds`), so a fresh `pnpm install` works unattended.

---

## 10a. Containers and deployment

```mermaid
flowchart LR
    U["Browser"] --> N["frontend<br/>nginx :80 → host 8080"]
    N -- "/ , /assets" --> SPA["built SPA (dist/)"]
    N -- "/api /admin /static" --> B["backend<br/>gunicorn :8000"]
    B --> DB[("db<br/>postgres:16")]
    B -. enqueue .-> R[("redis:7")]
    R --> W["worker<br/>celery worker"]
    BT["beat<br/>celery beat"] -. schedule .-> R
    W --> DB
    B --- M[("media volume")]
    W --- M
```

| Image | Build | Runs |
|---|---|---|
| `flowboard-backend` | `python:3.13-slim`; installs `requirements.txt`, runs `collectstatic` at build time, non-root user `flowboard` | `docker-entrypoint.sh` with `web` (wait for DB → `migrate` → optional `seed_demo` → gunicorn), `worker` or `beat`. Health check: `GET /api/health/` |
| `flowboard-frontend` | stage 1 `node:24-alpine` + corepack pnpm → `pnpm install --frozen-lockfile` + `pnpm build`; stage 2 `nginx:1.29-alpine` | nginx from `nginx.conf.template`: SPA fallback to `index.html`, immutable caching for `/assets/`, gzip, 110 MB upload cap, `/healthz` |

- **Start order:** `backend` waits for healthy `db` and `redis`; `worker`, `beat` and `frontend` wait for a
  healthy `backend`, so migrations finish before anything else touches the database.
- **Attachments** stay private: nginx doesn't serve `/media`; downloads go through the authenticated
  `/api/attachments/{id}/download/` view, reading from the shared `media` volume.
- **Settings stay identical to dev**: the image only changes env vars (`DJANGO_DEBUG=False`, whitenoise
  storage, media root), so local dev and the 270 tests run on unchanged defaults.
- **Production** (`docker-compose.prod.yml`) uses the GHCR images, requires `DJANGO_SECRET_KEY`,
  `POSTGRES_PASSWORD`, `APP_DOMAIN` and `IMAGE_PREFIX`, doesn't publish the database or Redis ports, defaults
  `SEED_DEMO_DATA` to false and turns on secure cookies. TLS is terminated by a proxy in front; nginx keeps
  its `X-Forwarded-Proto`.

### CI/CD pipeline (`.github/workflows/ci.yml`)

```mermaid
flowchart LR
    P["push / PR"] --> BE["backend<br/>check · migrations · pytest<br/>(Postgres + Redis services)"]
    P --> FE["frontend<br/>pnpm install · pnpm build"]
    BE --> D["docker<br/>compose build · up --wait<br/>smoke_test.py"]
    FE --> D
    D -- "main only" --> G["push to GHCR<br/>latest + SHA"]
    G --> DEP["deploy (production env)<br/>scp compose → pull → up -d"]
```

The deploy job skips itself, with a notice, until `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY` exist.
Image pushes use the workflow's own `GITHUB_TOKEN` (`packages: write`); no personal credentials are stored.

---

## 11. Testing strategy

| Level | Tooling | Scope |
|---|---|---|
| Backend (270 tests) | pytest-django on **real PostgreSQL**, DRF `APIClient` | tenancy, roles, cross-tenant attacks, workflows, collaboration, tasks, reports, audit, email, billing (limits, checkout/portal, webhook signatures, idempotency, plan sync), malformed input. Tasks run in-process and never reach the real Redis; Stripe calls are mocked |
| Types | `tsc -b` (strict, `noUnused*`) | the whole frontend |
| Stack smoke test | `scripts/smoke_test.py` (stdlib only), run in CI against the Docker stack | 26 checks through nginx: login, projects/issues/boards/sprints/dashboard, tenant isolation, role blocks, comments, upload + download, worker-built report + CSV, notifications, webhooks, billing, unsigned Stripe webhook rejected, OpenAPI schema |
| Browser checks | headless Chromium during development | demo login, dashboard, board drag → persisted status, backlog drag → persisted sprint, create via `C`, palette search, viewer read-only, workspace switching, dark mode, billing, a real Stripe test payment |

The tests use Postgres rather than SQLite because partial unique indexes, check constraints and
row-locking behaviour are part of what's being tested.

---

## 12. Roadmap

| Phase | Delivered | Status |
|---|---|---|
| 1 | Shared-schema tenancy, models, Faker seed | ✅ |
| 2 | REST API, JWT, roles, invitations, OpenAPI | ✅ |
| 3 | React SPA, drag-and-drop Kanban and backlog, dashboard | ✅ |
| 4 | Workflow editor, comments + mentions, attachments, audit log | ✅ |
| 5 | Webhooks, notifications, email, reports, Celery beat | ✅ |
| 6 | Stripe Billing: plans, Checkout, Portal, webhooks, 402 limits ([8a](#8a-billing-stripe)) | ✅ |
| 7 | Docker images, full-stack compose, GitHub Actions CI/CD ([10a](#10a-containers-and-deployment)) | ✅ |

Possible next steps: frontend unit tests and a linter in CI, splitting the main JS bundle, browser E2E
tests in CI, and an HTTPS reverse proxy (e.g. Caddy) in the production compose file.
