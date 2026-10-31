# FlowBoard architecture

How FlowBoard is put together: the moving parts, how tenants are kept apart, the data model, and
the reasoning behind the main design decisions. For setup see the [README](../README.md); for
exercising the API see [API_TEST.md](API_TEST.md).

> **Status:** Phases 1–3 are implemented (tenancy + models, REST API, React UI). Parts marked
> *planned* arrive in Phases 4–7 and are described in [section 12](#12-roadmap).

- [1. System overview](#1-system-overview)
- [2. Tech stack](#2-tech-stack)
- [3. Repository layout](#3-repository-layout)
- [4. Multi-tenancy](#4-multi-tenancy)
- [5. Data model](#5-data-model)
- [6. Domain rules](#6-domain-rules)
- [7. Authentication and authorization](#7-authentication-and-authorization)
- [8. Backend design](#8-backend-design)
- [9. Frontend design](#9-frontend-design)
- [10. Local environment](#10-local-environment)
- [11. Testing strategy](#11-testing-strategy)
- [12. Roadmap](#12-roadmap)

---

## 1. System overview

```mermaid
flowchart LR
    subgraph Browser
        SPA["React SPA<br/>(TypeScript, TanStack Query, dnd-kit)"]
    end
    subgraph Dev["Vite dev server :5173"]
        Proxy["/api proxy"]
    end
    subgraph Backend["Django :8000"]
        MW["TenantMiddleware"]
        DRF["DRF viewsets<br/>WorkspaceScopedMixin"]
        ORM["TenantModel / TenantQuerySet"]
    end
    PG[("PostgreSQL 16<br/>shared schema")]
    Redis[("Redis 7")]
    Worker["Celery worker + beat<br/><i>planned · Phase 5</i>"]
    Stripe["Stripe Billing<br/><i>planned · Phase 6</i>"]

    SPA -- "JWT + X-Workspace" --> Proxy --> MW --> DRF --> ORM --> PG
    DRF -. "enqueue jobs" .-> Redis -.-> Worker
    Worker -.-> PG
    DRF -. "checkout / webhooks" .-> Stripe
```

- The browser only ever talks to **one origin**. In dev, Vite proxies `/api` to Django, so no CORS is
  involved. CORS is still configured (`CORS_ALLOWED_ORIGINS`, with `x-workspace` allowed) for setups
  where the SPA is served from somewhere else.
- Django is a **pure JSON API**. It renders no HTML except the admin and the Swagger UI.
- Redis is already provisioned by `docker-compose.yml` (host port 6380) for the Celery work in Phase 5.

---

## 2. Tech stack

| Layer | Technology | Version | Why |
|---|---|---|---|
| API | Django + Django REST Framework | 5.2 LTS · 3.18 | Mature ORM/migrations, serializers, permission system |
| Auth | djangorestframework-simplejwt (+ token blacklist) | 5.5 | Stateless JWT for an SPA; rotation + revocation |
| Filtering | django-filter | 26.2 | Declarative query-param filters |
| API docs | drf-spectacular | 0.30 | OpenAPI 3 schema + Swagger UI from the code |
| Database | PostgreSQL (psycopg 3) | 16 | Partial unique indexes, check constraints, row locks |
| Cache/broker | Redis | 7 | Celery broker (Phase 5) |
| Frontend | React + TypeScript | 19.3 · 5.9 | Strict typing across ~50 modules |
| Build | Vite + pnpm | 7.3 · 12.16 | Fast dev server with proxy; strict, reproducible installs |
| Routing | React Router (library mode) | 7.18 | Nested layouts (workspace → project → tab) |
| Server state | TanStack Query | 5.105 | Caching, invalidation, optimistic updates |
| Client state | Zustand (persist) | 5.0 | Auth tokens + UI prefs in localStorage |
| UI | Tailwind CSS v4, Headless UI, lucide-react | 4.3 · 2.2 · 1.x | Accessible primitives, design tokens, dark mode |
| Drag & drop | dnd-kit (core + sortable) | 6.3 · 10.0 | Multi-container sortable lists, keyboard support |
| Charts | Recharts | 3.10 | Dashboard charts |
| Infra | Docker Compose | n/a | Postgres + Redis locally (app images in Phase 7) |

---

## 3. Repository layout

```
.
├── docker-compose.yml          Postgres + Redis for local dev
├── .env.example                every setting, with dev defaults (copy to .env)
├── README.md
├── docs/
│   ├── API_TEST.md             manual + automated API testing guide
│   └── ARCHITECTURE.md         this file
├── backend/
│   ├── manage.py · requirements.txt · pytest.ini · conftest.py
│   ├── config/                 settings.py (env-driven), urls.py, wsgi/asgi
│   └── apps/
│       ├── core/               tenancy primitives, API base classes, seed command, tests
│       ├── accounts/           custom User (email login), auth endpoints
│       ├── tenants/            Workspace, Membership, Invitation
│       ├── projects/           Project, Workflow, WorkflowStatus, WorkflowTransition, Board, Sprint
│       └── issues/             Issue, Label, move/rank service, filters, dashboard
└── frontend/
    ├── package.json · pnpm-lock.yaml · pnpm-workspace.yaml · vite.config.ts
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
        │   └── sprints/        sprint create/start/complete modals
        └── pages/              auth/, project/ (Board, Backlog), Dashboard, Issues, Members…
```

### Backend apps

| App | Owns | Key modules |
|---|---|---|
| `core` | The tenancy framework that every other app builds on | `models.py` (TenantModel, TenantQuerySet), `context.py` (ContextVar), `middleware.py`, `api.py` (WorkspaceScopedMixin, TenantModelViewSet), `permissions.py`, `fields.py`, `exceptions.py`, `pagination.py`, `schema.py`, `management/commands/seed_demo.py` |
| `accounts` | Identity | `User` (email is the username), register/login/refresh/logout/me/change-password |
| `tenants` | The tenant itself | `Workspace`, `Membership` (role), `Invitation`; services `create_workspace`, `accept_invitation` |
| `projects` | Containers of work | `Project`, `Workflow` + statuses + transitions, `Board`, `Sprint`; `services.create_project` scaffolds a workflow and a board |
| `issues` | Work items | `Issue`, `Label`; `services.move_issue` (ranking), `filters.IssueFilter`, `dashboard.DashboardView`, M2M tenant guard in `signals.py` |

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
```

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
| **Workflows** | Each project owns one `Workflow` with ordered `WorkflowStatus` rows (category todo/in_progress/done). With `enforce_transitions = False` (the default) any move is allowed; when it's True, only explicit `WorkflowTransition` rows are. This is checked in both the serializer (PATCH) and `move_issue`. The editor UI arrives in Phase 4. |
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
| Projects, boards (WIP), delete sprints/labels | | | ✅ | ✅ |
| Invitations, roles, removing members, renaming the workspace | | | ✅ | ✅ |
| Delete the workspace | | | | ✅ |

The frontend mirrors this ladder in `usePermissions()` and hides what the API would refuse. The API
stays the authority either way.

---

## 8. Backend design

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
| Seed data | `seed_demo` (Faker, deterministic seed 42): 3 workspaces, 7 projects, ~336 issues, epics, labels, closed/active/planned sprints, believable created/resolved timelines |

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
    │   └── issues       table scoped to the project
    ├── issues           table across all projects
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

| Env var | Default (dev) | Used for |
|---|---|---|
| `DJANGO_SECRET_KEY` | long dev placeholder | signing, including JWTs (HS256 needs ≥ 32 bytes) |
| `DJANGO_DEBUG` / `DJANGO_ALLOWED_HOSTS` | `True` / `localhost,127.0.0.1` | |
| `DATABASE_URL` | `postgres://flowboard:flowboard@localhost:5432/flowboard` | dj-database-url |
| `POSTGRES_DB/USER/PASSWORD/HOST_PORT` | `flowboard` ×3 / 5432 | docker compose |
| `REDIS_URL` / `REDIS_HOST_PORT` | `redis://localhost:6380/0` / 6380 | Celery (Phase 5) |
| `FRONTEND_URL` | `http://localhost:5173` | building invitation links |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | non-proxied setups |
| `VITE_API_PROXY` | `http://127.0.0.1:8000` | where Vite forwards `/api` (used by Docker in Phase 7) |

pnpm 12 blocks dependency build scripts by default. The one that's needed (`esbuild`) is approved in
`frontend/pnpm-workspace.yaml` (`allowBuilds`), so a fresh `pnpm install` works unattended.

---

## 11. Testing strategy

| Level | Tooling | Scope |
|---|---|---|
| Model / tenancy | pytest-django on **real PostgreSQL** | query isolation, write guards, constraints, domain rules (21 tests) |
| API | DRF `APIClient` | auth flows, every role boundary, cross-tenant attacks, sprints, invitations, dashboard, schema (36 tests) |
| Types | `tsc -b` (strict, `noUnused*`) | the whole frontend |
| End-to-end | headless Chromium (Playwright) during development | demo login, dashboard, board drag → persisted status, backlog drag → persisted sprint, create via `C`, palette search, viewer read-only, workspace switching, dark mode. Automated E2E in CI is planned with the Phase 7 pipeline |

The tests use Postgres rather than SQLite because partial unique indexes, check constraints and
row-locking behaviour are part of what's being tested.

---

## 12. Roadmap

| Phase | Adds | Architectural impact |
|---|---|---|
| 4 | Workflow editor, comments (@mentions), attachments, audit log | `WorkflowTransition` UI and board drop-target rules; new tenant models `Comment`, `Attachment` (media storage, plan-based size limits) and `AuditLog` (signals with before/after diffs) |
| 5 | Webhooks + Celery | Celery worker + beat on Redis; tasks bind the tenant with `workspace_context()`; HMAC-signed webhook delivery with retries and a delivery log; notifications and reports |
| 6 | Stripe Billing (test mode) | `Subscription`/plan models, Checkout + Customer Portal, webhook endpoint, plan limits enforced in services (HTTP 402 → upgrade prompt) |
| 7 | Docker + GitHub Actions | backend (gunicorn) and frontend (nginx serving `dist/` and proxying `/api`) images; CI: lint → pytest with Postgres/Redis services → `pnpm build` → images → deploy |
