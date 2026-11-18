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
| Client state | Zustand | 5.0 | Auth in memory only (refresh token is an httpOnly cookie); UI prefs persisted in localStorage |
| UI | Tailwind CSS v4, Headless UI, lucide-react | 4.3 · 2.2 · 1.x | Accessible primitives, design tokens, dark mode |
| Drag & drop | dnd-kit (core + sortable) | 6.3 · 10.0 | Multi-container sortable lists, keyboard support |
| Charts | Recharts | 3.10 | Dashboard charts |
| Frontend tests | Vitest + React Testing Library (jsdom) | 3.2 · 16.3 | Unit and component tests, reuse the Vite config |
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
├── scripts/nginx_security_test.sh  nginx hardening checks against the built frontend image
├── e2e/                       Playwright browser tests of the 8 main user flows (run against an isolated stack)
├── load/k6-api.js             k6 load test: ramping signed-in users, auth, reports, webhooks
├── README.md
├── docs/
│   ├── API_TEST.md             manual + automated API testing guide
│   ├── ARCHITECTURE.md         this file
│   ├── TEST_RESULTS.md         measured test results and API response times
│   ├── DEMO.md                 demo script
│   ├── PRESENTATION.md         final presentation outline
│   ├── REFLECTION.md           individual reflection
│   └── screenshots/            14 app screenshots used in the README
├── backend/
│   ├── manage.py · requirements.txt · pytest.ini · conftest.py
│   ├── Dockerfile · docker-entrypoint.sh · .dockerignore
│   ├── config/                 settings.py (env-driven), urls.py, wsgi/asgi, celery.py
│   └── apps/
│       ├── core/               tenancy primitives, API base classes, request logging + redaction, API docs gate, seed command, tests
│       ├── accounts/           custom User (email login), auth endpoints, refresh-token cookie, login lockout
│       ├── tenants/            Workspace, Membership, Invitation
│       ├── projects/           Project, Workflow, WorkflowStatus, WorkflowTransition, Board, Sprint
│       ├── issues/             Issue, Label, comments, attachments, AuditLog, move service, filters, dashboard
│       ├── automation/         webhooks, notifications, reports, email, Celery tasks and templates
│       └── billing/            plans, limits, Subscription, Stripe services + webhook, stripe_setup command
└── frontend/
    ├── package.json · pnpm-lock.yaml · pnpm-workspace.yaml · vite.config.ts
    ├── Dockerfile · nginx.conf.template · proxy-backend.inc.template · .dockerignore
    ├── docker/                 40-security-snippets.sh: admin allowlist, trusted proxies, headers and CSP, generated at start
    ├── scripts/                csp-style-hashes.mjs: CSP hashes for inline styles, computed at build time
    └── src/
        ├── main.tsx · App.tsx · router.tsx · index.css · types.ts
        ├── lib/                api client, session (cookie refresh, Web Locks, restore, logout), query client, utils, constants
        ├── store/              zustand: auth (in memory only), ui
        ├── test/               Vitest setup (jest-dom matchers, cleanup); *.test.ts(x) sit next to their code
        ├── hooks/              queries.ts (all API hooks), useWorkspace, useSortableContainers
        ├── components/
        │   ├── ui/             Button, Input, Modal/Drawer, Select, Dropdown, Avatar…
        │   ├── layout/         WorkspaceLayout, Sidebar, Topbar, CommandPalette…
        │   ├── issues/         IssueCard, IssueDrawer, CreateIssueModal, IssueMeta
        │   ├── board/          KanbanColumn, BoardFilters
        │   ├── sprints/        sprint create/start/complete modals
        │   └── settings/       webhook management
        └── pages/              Landing (public home), auth/, project/ (Board, Backlog, Workflow), Dashboard, Issues, Reports, AuditLog, Billing, Members…
```

### Backend apps

| App | Owns | Key modules |
|---|---|---|
| `core` | The tenancy framework that every other app builds on | `models.py` (TenantModel, TenantQuerySet), `context.py` (ContextVar), `middleware.py`, `api.py` (WorkspaceScopedMixin, TenantModelViewSet), `permissions.py`, `fields.py`, `exceptions.py`, `pagination.py`, `schema.py`, `management/commands/seed_demo.py`, `request_logging.py` (request ids, `redact_path`), `docs.py` (`API_DOCS` gate) |
| `accounts` | Identity | `User` (email is the username), register/login/refresh/logout/me/change-password; `cookie_auth.py` (httpOnly refresh cookie), `lockout.py` (shared API/admin login lockout) |
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
        string slug UK "lowercase-hyphenated (CHECK)"
        string plan "free | pro | enterprise"
        int owner_id FK
        datetime deleting_at "set when deletion starts"
    }
    MEMBERSHIP {
        int workspace_id FK
        int user_id FK
        string role "owner | admin | member | viewer"
    }
    INVITATION {
        string email
        string role
        string token_hash UK "SHA-256 of the link token"
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
        int project_id FK "one per project"
        string board_type "kanban | scrum"
        json wip_limits "object of whole numbers >= 1 (CHECK)"
    }
    SPRINT {
        int project_id FK
        string state "planned | active | closed"
        date start_date
        date end_date
        datetime completed_at "set exactly when closed (CHECK)"
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

The schema review (all 21 tables) moved every rule that a bulk write, the admin or raw SQL could break into the
database. Each migration that adds a rule first **reports** rows that already break it (ids and values) and stops;
it never rewrites, truncates or deletes data silently.

**Uniqueness and identity**

| Constraint | Rule |
|---|---|
| `unique_membership`, `uq_one_owner_per_workspace` | one membership per (workspace, user); exactly one owner |
| `unique_project_key_per_workspace` + `project_key_canonical` | keys are uppercase, unique per workspace |
| `unique_issue_number_per_project`, `unique_issue_key_per_workspace` | issue keys never collide |
| `one_active_sprint_per_project` | partial unique index where `state = 'active'` |
| `uq_status_name_ci_per_workflow` | status names unique per workflow **ignoring case** (`(workflow_id, LOWER(name))`) |
| `uq_status_position_per_workflow` | positions unique, checked at commit (the editor renumbers row by row) |
| `unique_transition`, `transition_not_self` | one transition per (from, to); no self-transition |
| `unique_label_per_workspace` + `label_name_lowercase` | label names per workspace; the app stores the canonical form (NFC + casefold) |
| `uq_one_board_per_project`, `UNIQUE(workflow.project_id)` | one board and one workflow per project |
| `unique_open_invitation`, `uq_invitation_token_hash` | one open invitation per (workspace, email); tokens stored only as SHA-256 hashes |
| `unique_webhook_event_delivery` | one original delivery per (endpoint, event id) where `NOT is_redelivery`; `is_redelivery` is fixed at creation (trigger), so deleting an original never turns its redeliveries into "originals" |
| `one_pending_identical_report` | one pending report per (workspace, type, project, sprint), `NULLS NOT DISTINCT`, only while the report still has its source (summary always; velocity with a project; burndown with a sprint) |
| `uq_subscription_stripe_id` | one Stripe subscription per workspace (where the id is not empty) |
| `UNIQUE(stripe_customer_id)`, `UNIQUE(StripeEvent.event_id)` | Stripe customer and processed-event idempotency |

**Value and state checks**

| Table | CHECKs |
|---|---|
| workspace | slug matches `^[a-z0-9]+(-[a-z0-9]+)*$`; name not blank; plan in the catalogue |
| project | name not blank; description ≤ 10,000 characters; colour hex |
| workflow / status | names not blank; status names also without leading or trailing spaces; category and colour |
| sprint | name not blank; goal ≤ 10,000 characters; `end ≥ start`; active ⇒ both dates; `completed_at` set exactly when closed |
| board | name not blank; `wip_limits` is a JSON object whose values are whole numbers ≥ 1 (`jsonb_path_exists`, strict mode) |
| issue, comment | description ≤ 50,000, comment body ≤ 10,000 characters; priority, type, story points ranges |
| label | name lowercase and not blank; colour hex |
| attachment | size ≤ 100 MB; content type in the verified list (one canonical type per extension) |
| webhook endpoint | name not blank; `events` is a JSON array; an active endpoint carries no auto-disable record |
| webhook delivery | delivered ⇒ `delivered_at`; processing ⇒ claim + lease; delivered/failed ⇒ no lease; a redelivery pointer requires `is_redelivery` |
| report | `error` is set exactly when the report failed |
| subscription | status and subscription id both set or both empty; `checkout_plan` in the paid plans (a test keeps it in step with `billing/plans.py`) |
| Stripe event | `event_id` not empty |

**Cross-row rules (composite FKs and triggers)**

| Rule | How |
|---|---|
| A transition's statuses belong to its workflow, and its workspace is the workflow's | composite FKs `(from_status_id, workflow_id)`, `(to_status_id, workflow_id)` → status `(id, workflow_id)`, and `(workflow_id, workspace_id)` → workflow `(id, workspace_id)`, all `ON DELETE CASCADE`; a referenced status can't move to another workflow |
| Every project has its workflow | deferred constraint triggers checked at commit: a project committed without one, or a workflow deleted or moved while its project remains, fails (SQLSTATE `FB003` → 409). Creating both in one transaction and deleting a project work |
| No rows are created in a workspace that is being deleted | `BEFORE INSERT` trigger on all 18 workspace tables takes `FOR KEY SHARE` on the workspace row and rejects the insert once `deleting_at` is set (SQLSTATE `FB001` → 404) |
| A row's workspace never changes | `BEFORE UPDATE OF workspace_id` trigger on the same 18 tables (SQLSTATE `FB002` → 409) |

**Indexes** (each one measured; redundant single-column indexes whose column leads a composite or unique index
were dropped)

| Index | Serves |
|---|---|
| `(workspace, status)`, `(workspace, sprint)`, `(workspace, assignee)`, `rank` on issues | board, backlog, "my issues" and sprint totals |
| GIN trigram on `UPPER(key/title/description)` and audit `UPPER(entity_label)` | `?search=` (`icontains`) |
| `delivery_endpoint_newest (endpoint, created_at DESC, id DESC)` | a webhook's delivery history |
| `notification_inbox_newest (workspace, recipient, created_at DESC, id DESC)` and partial `notification_unread` | the notification bell (newest 100, unread count) |
| partial `delivery_finished_created`, `notification_created`, `stripeevent_created` | nightly retention batches |
| partial `delivery_processing_lease` (only `processing` rows) | the stalled-delivery sweeper |

---|---|
| `unique_membership` | one membership per (workspace, user) |
| `unique_project_key_per_workspace` + `project_key_canonical` | `WEB` can exist in many workspaces, once per workspace; the check constraint keeps keys uppercase, so uniqueness is effectively case-insensitive |
| `unique_issue_number_per_project`, `unique_issue_key_per_workspace` | issue keys never collide |
| `one_active_sprint_per_project` | **partial** unique index on `project` where `state = 'active'` |
| `sprint_end_after_start` | check constraint |
| `unique_status_name_per_workflow`, `unique_transition`, `transition_not_self` | workflow integrity |
| `unique_label_per_workspace` + `label_name_lowercase` | label names per tenant, stored lowercase so `Bug` and `bug` collide |
| `unique_open_invitation` | one open invitation per (workspace, `lower(email)`) where `accepted_at IS NULL` |
| `unique_webhook_event_delivery` | one *original* delivery per (endpoint, event id); redeliveries reuse the event id |
| `one_pending_identical_report` | one pending report per (workspace, type, project, sprint), `NULLS NOT DISTINCT` |
| indexes `(workspace, status)`, `(workspace, sprint)`, `(workspace, assignee)`, `rank` | board, backlog and "my issues" queries |
| GIN trigram indexes on `UPPER(key/title/description)` (`pg_trgm`) | `?search=`, which runs `icontains` as `UPPER(col) LIKE UPPER('%term%')`; created as raw SQL in `issues/0009` |
| `(state, lease_expires_at)` on webhook deliveries | the stalled-delivery sweeper |

---

## 6. Domain rules

| Rule | Implementation |
|---|---|
| **Issue keys** (`WEB-1`, `WEB-2`…) | `Project.allocate_issue_number()` runs `UPDATE … SET issue_counter = issue_counter + 1` inside the issue's transaction. The row lock serialises concurrent creators, and a failed save rolls the counter back, so no numbers are burned. Numbers of deleted issues are never reused. |
| **Ordering / drag-and-drop** | `Issue.rank` is a float. A move sends `prev_id` / `next_id` and the server sets `rank = (prev + next) / 2` (or ±1024 at either end). When two neighbours get closer than 1e-6 apart, `rebalance_ranks()` re-spaces the whole project in one `bulk_update`. Moving a card writes 1 row, not N. |
| **Resolution** | `resolved_at` is set when an issue enters a `done`-category status and cleared when it leaves one. Dashboards and sprint stats rely on it. |
| **Workflows** | Each project owns one `Workflow` with ordered `WorkflowStatus` rows (category todo/in_progress/done). With `enforce_transitions = False` (the default) any move is allowed; when it's True, only explicit `WorkflowTransition` rows are. This is checked in both the serializer (PATCH) and `move_issue`, and the board dims blocked columns during a drag. A status in use can't be removed or change category. With rules enforced, the editor requires at least one transition and every status must take part in one (in or out); separate groups (A→B and C→D) are fine, reachability isn't required. Status names starting with `__workflow_tmp_` are reserved for the editor's swap step. Transitions are written in one `bulk_create`; the workflow editor is their only write path (no admin inline). |
| **Archived projects** | Read-only. One guard, `projects/services.assert_project_writable()`, is called by every project-scoped write (issues, comments, attachments, sprints, board, workflow, project PATCH) and returns 400 `Restore the project first.` Reads, deleting the project and the restore itself still work. |
| **Removed members** | `tenants/services.remove_member()` unassigns all their issues in that workspace (closed ones too, since every save checks the assignee is a member) in the same transaction as the removal and records the count in the audit entry. Project lead roles are cleared by a signal. Reporter, comment author and audit actor are kept. |
| **Concurrency** | The **project row** is the lock point inside a project: workflow replacement and sprint start/complete take `FOR UPDATE`; issue create/update/move take `FOR NO KEY UPDATE`, which conflicts with it. Validation that a racing write could break (status still exists, parent hierarchy, cycles) runs after the lock. Workspace-wide limits (projects, labels, invitations, webhooks, reports) lock the **workspace row** with `FOR NO KEY UPDATE`; only the deletion mark uses `FOR UPDATE`, so ordinary locks never block or deadlock with inserts. Billing uses an advisory lock (see 8a). **Every PATCH follows one pattern** (issues, projects, sprints, boards, webhook endpoints): lock (project and/or row), **re-read**, **re-validate on the fresh row**, then save only the submitted fields with `update_fields`. A full-row save of a stale copy used to put back values written meanwhile (a rewound `issue_counter`, an undone sprint start, a re-enabled auto-disabled webhook, a restored pruned WIP limit). The database constraints above stay the last line of defence, and their `IntegrityError` is turned into a field-level 400 or a 409. |
| **Audit log** | `AuditLog` stores labels as text and uses `SET_NULL` on project, so entries outlive what they describe. Reordering inside a column is not logged. Only issue events trigger webhooks and notifications. |
| **Sprints** | `planned → active → closed`. Only one is active per project (DB-enforced). Completing a sprint moves unfinished issues to a planned sprint or the backlog in one transaction. Closed sprints are read-only, can't receive issues and can't be deleted (they're velocity history); only planned sprints can be deleted. Default names use the highest existing number + 1. |
| **Hierarchy** | epic → story/task/bug → subtask; a subtask has no children. Same project, no self-parenting, and a cycle walk up the chain. An issue can't change to a type that can't hold its existing children. Checked under the project lock, and only when the parent or type changes, so older issues stay editable. |
| **Deletion** | `Issue.status` uses `on_delete=RESTRICT`: a status in use can't be deleted on its own, but deleting a project or workspace cascades cleanly. (`PROTECT` would block those cascades.) |
| **Project scaffolding** | `create_project()` creates the project, a 4-status workflow (To Do, In Progress, In Review, Done) and a board in one transaction. |
| **Destructive deletes** | Deleting a project (owner only) needs `{"confirm": "<KEY>"}`; deleting a workspace needs the slug and the owner's password and is **asynchronous** (see [Workspace deletion](#workspace-deletion)). Attachment files are deleted with `transaction.on_commit(robust=True)`, one callback per file, so a rolled-back delete never loses a file and a storage error never turns a committed delete into a 500 or skips the other files; the nightly sweep removes anything left behind. |
| **Ownership** | `transfer_ownership()` locks the workspace and memberships, demotes the old owner to admin before promoting the new one (never two owners), updates `Workspace.owner`, audits it, and queues the Stripe billing-email update after commit. An admin invitation is only valid while its sender still owns the workspace. |
| **Uploads** | The bytes decide: magic-number checks for images, PDF and ZIP; UTF-8 without NUL bytes for text; SVG/HTML and anything else rejected; one canonical type per extension is stored (`ATTACHMENT_TYPES`, e.g. `text/csv`, `application/zip`), the same list the DB CHECK allows. The file is written first and the row and audit entry in one transaction; if that fails, the stored file is deleted again. A per-issue attachment list returns the newest 200 (or `?page=`). |
| **Labels** | Names are canonicalised once (`canonical_label_name`: trim, Unicode NFC + casefold), so `ΣΑΣ`/`σας`/`σασ` and composed/decomposed accents are the same label; the 40-character limit applies after folding. Limits: 500 labels per workspace (under the workspace lock) and 20 per issue (the resulting set; an `m2m_changed` backstop covers every write path). `?label=` filters with `EXISTS`, not `JOIN … DISTINCT`. |
| **Sprints and boards** | Sprint and project lists compute issue totals with one grouped query for the rows shown (sprints) or correlated subqueries (projects), never a `COUNT(DISTINCT)` join over every issue; PATCH, DELETE, start and complete don't compute them. |

---

## 7. Authentication and authorization

### Tokens

| | Value | Notes |
|---|---|---|
| Access token | 30 min | `Authorization: Bearer …` |
| Refresh token | 7 days | rotated on every refresh; the old one is blacklisted (`token_blacklist` app). Browser: httpOnly cookie only (see [7.1](#71-browser-sessions-refresh-token-in-an-httponly-cookie)); scripts: JSON body |
| Expired-token cleanup | nightly at 03:45 | Celery beat `flush_expired_tokens` deletes expired `OutstandingToken` rows (and their blacklist rows) in batches; revoked tokens that haven't expired stay revoked |
| Logout | blacklists that refresh token (204, idempotent) | `logout-all` blacklists every outstanding one; the access token expires naturally |
| Password change / reset | revokes every refresh token | change returns a fresh pair; reset uses Django's single-use `PasswordResetTokenGenerator` (1 hour) and always answers 204 |
| Brute-force protection | per-endpoint scopes (login 5/min, register 10/h, change-password 5/h, reset 5/h) | plus a per-email lockout: 10 failures in 15 min. Counters are in the shared Redis cache |
| Refresh limits | layered (`apps/accounts/throttles.py`) | every page load refreshes, and offices share one IP, so: **30/min per verified account** (from a token whose signature, expiry and type are checked and that isn't blacklisted, never an unverified claim), **30/min per IP for invalid tokens** (missing, forged, expired, revoked), and a **600/min per IP** ceiling. A 429 carries `Retry-After` and leaves the cookie alone |
| Passwords | Django validators | length, common, numeric, similarity; errors are reported on the password field |
| Session auth | not used by the API | JWT only; Django admin keeps its own session login (shares the Redis login lockout; nginx limits it to `ADMIN_ALLOWLIST`) |
| Deactivated users | refused | access tokens fail authentication and refresh is refused (SimpleJWT checks `is_active`) |

### 7.1 Browser sessions: refresh token in an httpOnly cookie

The SPA sends `X-Auth-Mode: cookie` on every request (`apps/accounts/cookie_auth.py`). In that mode:

- login, register, change-password and refresh put the refresh token **only** in the `fb_refresh` cookie
  (HttpOnly, `SameSite=Strict`, `Path=/api/auth/`, Secure wherever `SESSION_COOKIE_SECURE` is on, 7-day
  `Max-Age`) and leave it out of the JSON body;
- refresh and logout read it **only** from that cookie. A body token is ignored, and a missing or invalid cookie
  is a 401 that also clears the cookie. Clearing uses the same attributes as setting;
- logout always clears the cookie and returns 204; logout-all also clears it.

Without the header (curl, scripts, tests) the API is unchanged: tokens in the body, cookie never read or set.
**CSRF:** `SameSite=Strict` keeps the cookie off cross-site requests, and the custom header forces a CORS
preflight that production (no allowed origins) never grants. This depends on CORS staying closed.

The access token lives **only in memory** (`store/auth.ts`); nothing is persisted, and the old
`flowboard-auth` localStorage entry is removed on load. See [9.3](#93-api-client) for restore and refresh.

### 7.2 Security hardening (production configuration and logging)

| Area | What's in place |
|---|---|
| Admin | nginx serves `/admin/` only to `ADMIN_ALLOWLIST` (comma-separated IPs/CIDRs; empty = closed, a plain 404); admin login rate limited per IP; a malformed allowlist stops the container |
| Proxy trust | nginx takes the real client IP from `X-Forwarded-For` only when the TCP peer is in `TRUSTED_PROXY_CIDRS` (set it to the TLS load balancer's address in production, or every user appears to come from the balancer). Django's per-IP limits trust only the last `X-Forwarded-For` entry, the one nginx adds (`NUM_PROXIES=1` when `DJANGO_BEHIND_PROXY` is set); before, a client could send a different header per request to escape every per-IP limit |
| Headers | `server_tokens off`, `X-Frame-Options DENY`, `nosniff`, `Referrer-Policy same-origin`, `Permissions-Policy`, and a strict CSP without `unsafe-inline`/`unsafe-eval`: the theme script's hash is computed at container start, the toast library's style hash at build time. `CSP_HEADER` can switch to report-only while checking a change |
| HTTPS | production: SSL redirect (except `/api/health/`), HSTS for one year; `includeSubDomains`/`preload` are opt-in (`DJANGO_HSTS_INCLUDE_SUBDOMAINS`, `DJANGO_HSTS_PRELOAD`) |
| API docs | `API_DOCS` = `public`, `staff` or `off` (404). Default: public with DEBUG, off otherwise |
| CORS | allowed origins default to the Vite dev server only with DEBUG; production is empty (same origin through nginx) |
| Login lockout | `apps/accounts/lockout.py`: 10 failures in 15 min per email, in Redis, shared by the API login and the Django admin |
| Secrets in logs | Reset (`/reset-password/…`), invite (`/invite/…`) and invite-preview paths, the same paths inside query strings (raw or `%2F`-encoded), and the values of `token`, `uid`, `key`, `secret`, `password`, `code`, `refresh` and `access` query parameters are logged as `[REDACTED]`. Django: `redact_path()` in the `flowboard.request` line, plus a `RedactSecretPaths` filter on the console handler. nginx: the `fb_redacted` access-log format, which keeps status, `rt=`, `ups=` and `urt=`. nginx error lines can't be reformatted, so only the token routes (and API requests with secret query parameters, through an internal location) log critical errors only; everything else keeps normal error logging |
| Uploads | allowlisted extensions and content types (DB CHECK); downloads are `application/octet-stream` attachments with `nosniff` |
| Outgoing webhooks | HTTPS only, every resolved IP must be public, the connection is pinned to the checked IP (no DNS rebinding), redirects are refused, hard deadline |
| Stripe webhooks | signature verified (5-minute tolerance), each event id processed once |

### Roles

`owner > admin > member > viewer` (`Membership.ROLE_RANK`). Views declare only their exceptions:

```python
class ProjectViewSet(TenantModelViewSet):
    required_roles = {"create": Role.ADMIN, "update": Role.ADMIN, "partial_update": Role.ADMIN, "destroy": Role.OWNER}
    # everything else: reads → VIEWER, writes → MEMBER (the default in core/permissions.py)
```

Object-level rules live in services (`tenants/services.py`, `issues/services.py`), not only in views: only the
owner manages admins; nobody changes their own role or anyone's to owner (that's `transfer-ownership`); anyone but
the owner may leave; an issue can be deleted by its reporter or an admin; a comment can be edited only by its
author and deleted by its author or an admin.

| Capability | Viewer | Member | Admin | Owner |
|---|:-:|:-:|:-:|:-:|
| Read the workspace | ✅ | ✅ | ✅ | ✅ |
| Issues, sprints, labels: create/edit/move | | ✅ | ✅ | ✅ |
| Delete an issue | | own | ✅ | ✅ |
| Edit a comment | | own | own | own |
| Delete a comment | | own | ✅ | ✅ |
| Projects (create/edit/archive), workflows, boards (WIP), webhooks, audit log, delete planned sprints/labels | | | ✅ | ✅ |
| Invite and manage members and viewers, rename the workspace | | | ✅ | ✅ |
| Invite, promote, demote or remove **admins** | | | | ✅ |
| See the plan, usage and `over_limit` (`GET /billing/`) | ✅ | ✅ | ✅ | ✅ |
| Checkout, Customer Portal, sync; delete a project or the workspace; transfer ownership | | | | ✅ |

The frontend mirrors this ladder in `usePermissions()` and hides what the API would refuse. The API
stays the authority either way.

---

## 8. Backend design

### Background jobs

| Job | Trigger | Behaviour |
|---|---|---|
| `process_issue_event` | after commit of an issue event | creates webhook deliveries (actor id + display name, no email) and notifications |
| `deliver_webhook` | per delivery | claim → send → record (below) |
| `recover_stalled_deliveries` | beat, every 5 min | re-queues deliveries whose worker lease expired |
| `generate_workspace_report` | `POST /reports/` | stores JSON on the report; writes only while it's still `pending`, so a run declared lost can't overwrite anything |
| `send_notification_email`, `send_invitation_email`, `send_password_reset_email` | on creation, resend or reset request | 3 retries on SMTP/network errors; never sends twice for a notification; honours the opt-out |
| `update_billing_email` (billing) | after an ownership transfer commits | points the Stripe customer at the current owner; up to 8 retries |
| `create_overdue_reminders`, `create_daily_digests` | beat, 08:00 and 08:05 UTC | one per person per day, enforced by a unique constraint; digests use one grouped count for all workspaces and skip zero-activity ones |
| `purge_expired_invitations` | beat, 03:00 | unaccepted invitations expired over 30 days ago |
| `purge_old_records` | beat, 03:15 | first fails reports stuck in `pending` for over 15 minutes (lost workers; conditional on `state='pending'`, in batches), then retention (below), in batches of 1,000, idempotent, logs its counts |
| `sweep_attachment_files` | beat, 03:30 | deletes stored files under `issues/` with no attachment row and older than 24 h (storage modified time, batches, DB re-checked before each delete); reports rows whose file is missing without deleting them |
| `delete_workspace` | after a workspace's deletion mark commits | the batched purge (see [Workspace deletion](#workspace-deletion)); Stripe errors retried with backoff |
| `resume_stalled_deletions` | beat, every 10 min | re-queues deletions pending for over 10 minutes (lost enqueue, crashed worker, exhausted retries) |

**Webhook delivery:**

| Step | Detail |
|---|---|
| Claim | `select_for_update(skip_locked=True)` on a `pending` row (or a `processing` one whose lease expired), set `processing` with a 60 s lease and a claim token, commit. A second worker gets nothing instead of sending twice |
| Send | outside any transaction. Signature `sha256=HMAC(secret, "<timestamp>.<raw body>")` with `X-FlowBoard-Timestamp`, fresh per attempt; `X-FlowBoard-Delivery` (event id) is stable. Each socket operation has an 8 s timeout and the whole attempt a hard 20 s deadline (well under the lease); at most 4 KB of the response is read |
| Record | 2xx → delivered and the endpoint's `consecutive_failures` reset. Network error, 5xx, 429 → retry with backoff (honouring `Retry-After`, capped at 1 h), up to 5 times. Other 4xx and redirects → failed at once. After 20 final failures in a row the endpoint is disabled, with one audit entry. **Every result write is fenced on the claim token** (`filter(pk, claim_token=mine, state='processing').update(…)`): a worker that stalled past its lease and was replaced writes nothing, schedules no retry and touches no endpoint counters |
| Redeliver | a new row pointing at the failed one (`redelivery_of`, `is_redelivery=True`), same event id and payload; history is never overwritten |

**Webhook target safety:** outside `DEBUG`, targets must be HTTPS and every resolved address must be public. The
validated IP is pinned for the connection, so a DNS answer that changes afterwards (DNS rebinding) can't reach
internal services. TLS still verifies the original hostname. Redirects and proxy variables are ignored. The same
rules apply to test sends, real events and redeliveries. With `DEBUG=True`, HTTP and local targets are allowed for
development. The signing secret is returned only by create and rotate; reads show `secret_hint`.

**Retention:** webhook deliveries 30 days, read notifications 90, unread notifications 180, reports 90, Stripe
events 90 (`RETENTION_DAYS`). Pending/processing deliveries and in-progress reports are never purged; a report
pending for over 15 minutes is a lost build, failed first and then aged out like any other.

### Workspace deletion

Deleting a large workspace in one request took 7.85 s for 20k issues in **one** transaction (about 1 ms per issue),
so around 150k issues would pass gunicorn's 60 s timeout, roll back, and become undeletable. Deletion is therefore
asynchronous (`apps/tenants/deletion.py`):

| Step | Detail |
|---|---|
| Request | `DELETE /api/workspace/` (owner; slug + password) marks `deleting_at` under `FOR UPDATE` and returns **202**. It never calls Stripe, so a crash can't leave a live workspace with a cancelled subscription |
| Hidden at once | `X-Workspace` resolution (every endpoint 404s), the workspace list, invitation links, the owned-workspace cap, webhooks, reminders and digests all skip it |
| No new rows | the insert trigger rejects writes that resolved the workspace just before the mark (404); inserts already in progress finish first, because the mark waits for their `FOR KEY SHARE` lock |
| Purge task | one at a time per workspace (advisory lock); cancels Stripe first, retrying with backoff and touching no data until Stripe confirms; then deletes comments, attachments (files after each batch commits), audit log, notifications, webhook deliveries and issues in batches of `WORKSPACE_DELETE_BATCH` (500), each in its own short transaction; the workspace row goes last and cascades the small rest |
| Recovery | `resume_stalled_deletions` re-queues anything pending for over 10 minutes; every step is idempotent and resumable |

Measured: 9.56 s in the background for the same 20k issues, but the longest single query/lock is 17 ms (was the
whole 7.85 s) and peak Python memory 4 MB (was 32 MB).

**Email policy:** mentions, new assignments, overdue issues and digests are emailed. Routine updates stay in-app.

**Burndown limitation:** it is computed from the issues currently in the sprint and their `resolved_at`, because
sprint membership history isn't stored. Issues moved out earlier don't appear in past days.

### Conventions

| Concern | Approach |
|---|---|
| Settings | `config/settings.py` reads everything from env / `.env` (secret, debug, hosts, `DATABASE_URL`, `REDIS_URL`, `FRONTEND_URL`, CORS) |
| Base classes | `TenantModelViewSet` = workspace resolution + scoped queryset + `perform_create` stamping the workspace. Most viewsets only add a serializer and filters. |
| Services | Business operations with multiple writes live in `services.py` (`create_workspace`, `transfer_ownership`, `remove_member`, `create_project`, `accept_invitation`, `move_issue`, `add_comment`, `add_attachment`, …) inside transactions, so the API, admin, seed and future jobs share them and the rules can't be skipped by another view |
| Lookups | Projects and issues by `key` (case-insensitive), everything else by id |
| Pagination | `OptionalPageNumberPagination`: a plain list unless `?page=` is sent (max 500). Big lists are bounded: `CappedListMixin` caps unpaged issue lists at 1,000 (`X-Truncated`) and requires a filter; `AlwaysPageNumberPagination` for the audit log; `paginate_or_cap()` for nested lists. Orderings always end with the pk, so pages are stable |
| Updates | `PATCH` only for projects, issues and webhooks (`PUT` → 405); the workflow keeps `PUT` because it is a full replace |
| Rate limits | DRF throttles per scope in `settings.REST_FRAMEWORK`, plus custom keys in `core/throttling.py` (per user, per endpoint, per workspace). Counters live in the shared Redis cache (`CACHES`, Redis database 1), so limits hold across processes |
| Errors | `core/exceptions.py` maps Django `ValidationError` (model/tenant guards) → 400 and `IntegrityError` → 409, so the API never 500s on bad input. Known races catch their `IntegrityError` and return a field-level 400 instead |
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
    API->>API: advisory lock for this workspace's billing
    API->>S: customer (once, idempotency key) · reuse our open session, else create one (idempotency key)
    API-->>O: {url}
    O->>S: pay on Stripe's hosted page (card never reaches FlowBoard)
    S-->>O: redirect /w/<slug>/billing?checkout=success
    O->>API: POST /billing/sync/ (re-reads the subscription from Stripe)
    S->>API: POST /api/billing/webhook/ (signed) checkout.session.completed, customer.subscription.*
    API->>S: list ALL the customer's subscriptions, no DB transaction open (events may arrive out of order)
    API->>S: cancel duplicates beyond the oldest live one (idempotency keys)
    API->>API: one short transaction: StripeEvent row + apply_subscription → Workspace.plan, audit log
```

| Concern | Approach |
|---|---|
| **Limits** | `billing/limits.py`: `check_can_add_project` (create and un-archive), `check_can_add_member` (invitations; pending invites count), `check_file_size` (attachments). They raise **402** `{"code": "plan_limit_reached", "limit": …, "current_plan": …}` and run under the workspace row lock. Limits only block adding more; a downgraded workspace keeps everything, and `GET /billing/` reports it in `over_limit` |
| **Checkout** | Runs under `pg_advisory_xact_lock(7301, workspace_id)` for its whole duration, Stripe calls included. It's transaction-scoped and blocks only another checkout or customer creation for the same workspace, not the workspace row. Customer creation uses the key `customer-ws-{id}`; the session uses `checkout-ws-{id}-{plan}-{10-minute window}`. The last session is reused only if **Stripe** reports it `open` with more than 2 minutes left. The plan is validated by name; the price is always chosen server-side |
| **Duplicate subscriptions** | Every subscription event and every sync lists all of the customer's subscriptions. With more than one live, the oldest is kept and the rest are cancelled (idempotent keys). They are **not refunded**: each gets an audit entry (workspace, retained and cancelled ids, detected at, result, `refund_issued: false`, `manual_refund_review_required: true`) |
| **Webhook security** | `StripeWebhookView` has no user auth; it verifies the `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET` (400 when invalid, 503 when not configured) |
| **Transaction boundary** | Stripe is called before any DB transaction opens; then one short transaction records the `StripeEvent` (unique) and applies the change. A known duplicate is answered before calling Stripe. Only the event-row insert, in its own savepoint, can mean "duplicate" (200); an `IntegrityError` while applying is a failure like any other. Stripe outage → 503, any other error → 500 with event id and type logged; either way no event row remains, so Stripe's retry runs it again. Processed-event rows are read-only in the admin (deleting one would re-arm the event) |
| **Ordering** | `apply_subscription()` locks the workspace row, then the subscription row (one order everywhere), and saves only the six fields it owns. Each snapshot carries the time its Stripe fetch **started**; a snapshot that started before the one already applied (`Subscription.synced_at`) is discarded, so an earlier request finishing later can't overwrite newer state. It isn't a Stripe event version, so `sync` stays available to reconcile |
| **Event handling** | `checkout.session.completed` and `customer.subscription.*` apply the canonical subscription; `invoice.payment_failed` notifies the owner (in-app + email). Paid statuses: `active`, `trialing`, `past_due`; ended (`canceled`, `unpaid`, `incomplete_expired`) → Free. An unknown price is logged with its id and lookup key and the plan is left unchanged |
| **No webhooks locally** | `POST /billing/sync/` reads the latest subscription directly, so billing works on a laptop without `stripe listen` |
| **Owner changes** | After an ownership transfer, `update_billing_email` sets the Stripe customer's email from the owner at the time it runs |
| **Workspace deletion** | The background purge cancels the live subscription (idempotency key) **after** the deletion mark has committed, saves the local status right away, and deletes no data until Stripe confirms; a failed purge doesn't cancel again on retry |
| **Error hygiene** | Stripe errors are logged in full but returned as a generic 503, since Stripe messages can expose account details |
| **Roles and limits** | Everyone can read `GET /billing/` (plan, usage, `over_limit`, `can_manage`); Checkout, Portal and Sync are owner-only. Checkout + Portal: 10/min per user; Sync: 6/min per workspace |

The frontend `BillingPage` shows the plan, usage bars and plan cards; it syncs after returning from
Checkout and shows a toast. A global 402 handler (`lib/queryClient.ts`) turns any limit error into a toast
with an **Upgrade** link.

---

## 9. Frontend design

### 9.1 Routing

```
/                        HomeEntry: logged out → LandingPage (lazy chunk) · logged in → last workspace's dashboard (or /onboarding)
/login · /register · /invite/:token                     public
RequireAuth
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

**Public home page.** `pages/LandingPage.tsx` is the product page visitors see first: a hero with a
board preview built in HTML/CSS (no screenshots, so it follows the theme), feature cards, the multi-tenancy
and roles section (reusing `ROLES` from `lib/constants.ts`), how-it-works steps, pricing, the tech stack and
an FAQ. It uses no API calls; its plan numbers mirror `backend/apps/billing/plans.py`, so change both together.
It's loaded with `React.lazy`, so it adds nothing to the app bundle that signed-in users download, and
animations respect `prefers-reduced-motion` (`motion-safe:`). It has its own light/dark toggle wired to the
same `useUI` theme store as the app.

The **workspace slug lives in the URL**, so links are shareable, and the browser back button switches
workspaces correctly. The open issue lives in the query string (`?issue=WEB-12`), so the drawer is
deep-linkable from any page.

### 9.2 State

| Kind | Tool | Notes |
|---|---|---|
| Server data | TanStack Query | Every key is namespaced `["ws", slug, …]`: two workspaces never share cache entries, and switching tenants can't flash the other tenant's data |
| Auth | Zustand `useAuth` (**memory only**) | access token, user, `status`: restoring / authenticated / anonymous / error. The refresh token is in the httpOnly cookie, never visible to JavaScript |
| UI prefs | Zustand `useUI` (persisted: theme, sidebar, last workspace) | also drives the create-issue modal and the command palette |
| URL | React Router | workspace, project, tab, open issue |

All API access goes through `hooks/queries.ts`. `useWsApi()` binds the request helpers to the
current workspace and attaches `X-Workspace` per request instead of using global mutable state.
Mutations invalidate the related keys (issues, sprints, projects, dashboard). A global
`MutationCache.onError` turns any failure into a toast with the server's message.

### 9.3 API client

`lib/api.ts` (axios):

- attaches the access token and `X-Auth-Mode: cookie` to every request;
- on a 401 it refreshes once and replays the request. Refreshes (`lib/session.ts`) are single-flight in a tab
  and serialised **across tabs with the Web Locks API**: refresh tokens rotate, so two tabs rotating the same
  cookie would revoke each other. After getting the lock, a tab first checks whether it already has a newer token.
  Browsers without Web Locks don't auto-refresh: an expired access token sends the user to log in again;
- a 400/401 from refresh means the session ended (auth cleared, then `/login?next=…`); a 429 means rate limited,
  not logged out (the session is kept and `SessionGate` shows a "too many requests" screen that counts down
  `Retry-After` and retries by itself); a network or 5xx error keeps the session.

**Page load:** `SessionGate` (`App.tsx`) calls `restoreSession()`: refresh through the cookie, then
`/auth/me/`, then render the protected routes. An ended session shows login; a network error shows a retry
screen. **Logout** counts only after the server answers 204 (a page can't delete an httpOnly cookie); otherwise
the user stays signed in and sees a toast. **Other tabs** hear about login and logout through a BroadcastChannel
that carries only `{type}`, never a token.

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
| Redis 7 | `docker compose up -d redis` | **6380** on the host (`REDIS_HOST_PORT`), so it doesn't clash with another Redis on 6379. Needed by the API (rate limits) and the tests, not only by Celery |
| Celery worker | `python -m celery -A config worker --pool=solo -l info` | n/a |
| Celery beat | `python -m celery -A config beat -l info` | n/a |

| Env var | Default (dev) | Used for |
|---|---|---|
| `DJANGO_SECRET_KEY` | long dev placeholder | signing, including JWTs (HS256 needs ≥ 32 bytes) |
| `DJANGO_DEBUG` / `DJANGO_ALLOWED_HOSTS` | `True` / `localhost,127.0.0.1` | |
| `DATABASE_URL` | `postgres://flowboard:flowboard@localhost:5432/flowboard` | dj-database-url |
| `POSTGRES_DB/USER/PASSWORD/HOST_PORT` | `flowboard` ×3 / 5432 | docker compose |
| `REDIS_URL` / `REDIS_HOST_PORT` | `redis://localhost:6380/0` / 6380 | Celery broker |
| `CACHE_URL` | `REDIS_URL` with database `/1` | shared cache for throttle and lockout counters |
| `MAX_OWNED_WORKSPACES` / `MAX_WEBHOOKS_PER_WORKSPACE` | 10 / 10 | per-user and per-workspace caps |
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
| `flowboard-frontend` | stage 1 `node:24-alpine` + corepack pnpm → `pnpm install --frozen-lockfile` + `pnpm build`; stage 2 `nginx:1.29-alpine` | nginx from `nginx.conf.template`: SPA fallback to `index.html`, immutable caching for `/assets/`, gzip, 110 MB upload cap, `/healthz`, plus the hardening in [7.2](#72-security-hardening-production-configuration-and-logging): admin allowlist, trusted proxies, security headers and CSP (generated at start by `docker/40-security-snippets.sh`), redacted access log |

- **Start order:** `backend` waits for healthy `db` and `redis`; `worker`, `beat` and `frontend` wait for a
  healthy `backend`, so migrations finish before anything else touches the database.
- **Attachments** stay private: nginx doesn't serve `/media`; downloads go through the authenticated
  `/api/attachments/{id}/download/` view, reading from the shared `media` volume.
- **Settings stay identical to dev**: the image only changes env vars (`DJANGO_DEBUG=False`, whitenoise
  storage, media root), so local dev and the backend tests run on unchanged defaults.
- **Production** (`docker-compose.prod.yml`) uses the GHCR images, requires `DJANGO_SECRET_KEY`,
  `POSTGRES_PASSWORD`, `APP_DOMAIN` and `IMAGE_PREFIX`, doesn't publish the database or Redis ports, defaults
  `SEED_DEMO_DATA` to false and turns on secure cookies, the SSL redirect, HSTS, an enforced CSP, `API_DOCS=off`,
  empty CORS origins and a closed admin unless `ADMIN_ALLOWLIST` is set. Redis has no password but is reachable only
  on the internal network. TLS is terminated by a proxy in front; nginx keeps
  its `X-Forwarded-Proto`.
- **Migrations and index locking (production risk):** the schema-review migrations create their indexes
  (the trigram GIN on the audit log, the delivery/notification composites, the retention indexes) **without
  `CONCURRENTLY`**, so each index build blocks writes to its table while it runs. On the development data all 32
  migrations took about 5 s, but on large production tables this would stall writes. Before deploying them to a
  big database, plan a maintenance window, or switch those operations to Django's `AddIndexConcurrently`
  (`django.contrib.postgres.operations`, in a migration with `atomic = False`); simply pre-creating an index by
  hand would make the matching `AddIndex` fail with "already exists". Also take a
  `pg_dump` first: some data steps (invitation token hashing, label canonicalisation) have no reverse.
- **Old containers must not run against a migrated database:** stop `backend`, `worker` and `beat` before
  migrating (or let the new image's `RUN_MIGRATIONS` do it on start); code from before the review queries
  columns that no longer exist (for example `Invitation.token`).
- **Production security settings** (all in `docker-compose.prod.yml`, see [7.2](#72-security-hardening-production-configuration-and-logging)):
  `ADMIN_ALLOWLIST` (empty = admin closed), `TRUSTED_PROXY_CIDRS` (your TLS proxy, otherwise client IPs are the
  proxy's), `CSP_HEADER` (switch to `Content-Security-Policy-Report-Only` only while checking a CSP change),
  `API_DOCS` (`off`), `DJANGO_HSTS_SECONDS` (one year; `DJANGO_HSTS_INCLUDE_SUBDOMAINS`/`DJANGO_HSTS_PRELOAD`
  only when every subdomain is HTTPS). After changing the nginx config, run `scripts/nginx_security_test.sh`.
- **Logs from before the redaction fix** may contain real password-reset and invitation tokens. Restrict who can
  read them and purge them under your retention policy; recreating the containers clears Docker's local logs.

### CI/CD pipeline (`.github/workflows/ci.yml`)

```mermaid
flowchart LR
    P["push / PR"] --> BE["backend<br/>check · migrations · pytest<br/>(Postgres + Redis services)"]
    P --> FE["frontend<br/>pnpm install · pnpm test (Vitest) · pnpm build"]
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
| Backend (995 tests) | pytest-django on **real PostgreSQL** and **Redis** (the shared throttle cache), DRF `APIClient` | tenancy, roles, cross-tenant attacks, workflows, collaboration, tasks, reports, audit, email, billing (limits, checkout/portal, webhook signatures, idempotency, plan sync), malformed input, plus the review hardening: race tests with real threads and connections (checkout, webhook cap, report dedupe, `skip_locked` claims), lock-order and query-count checks, `EXPLAIN` on the trigram index, a trickling socket for the webhook deadline; and the schema review: one `test_<table>_table.py` per table with lost-update races (stale PATCH vs concurrent writes), raw-SQL and bulk writes against every CHECK, trigger and composite FK, index plans, and each migration's "report and stop" path; and the security hardening: production settings, the shared admin/API lockout, cookie-mode auth, expired-token cleanup, log redaction and the layered refresh limits (including the spoofed `X-Forwarded-For` case). Celery tasks run eagerly and never touch the broker; Stripe calls are mocked |
| Frontend (68 tests) | **Vitest** + React Testing Library + user-event on `jsdom`; API hooks mocked | Kanban rank math, API error mapping and plan-limit detection, `Button` behaviour and accessibility, the in-memory auth store and legacy-token removal, session restore, refresh, Web Locks and logout (`lib/session.test.ts`), login page (submit, redirect, error, open-redirect guard), the session screens (401 / 429 / network), webhook deliveries (auto-refresh, Redeliver, permissions), and a render-loop regression for boards without an active sprint. Runs in CI before the build |
| Types | `tsc -b` (strict, `noUnused*`) | the whole frontend, including the test files |
| nginx security | `scripts/nginx_security_test.sh` against the built frontend image on an isolated Docker network | 33 checks: admin allowlist and trusted proxies, admin login rate limit, headers and CSP, access- and error-log redaction, config validation |
| Stack smoke test | `scripts/smoke_test.py` (stdlib only), run in CI against the Docker stack | 26 checks through nginx: login, projects/issues/boards/sprints/dashboard, tenant isolation, role blocks, comments, upload + download, worker-built report + CSV, notifications, webhooks, billing, unsigned Stripe webhook rejected, OpenAPI schema |
| Browser E2E | **Playwright** (`e2e/`), Chromium, against an isolated stack (`-p flowboard-e2e`) | 7 tests covering 8 flows: auth (cookie, reload, rotation, change password, logout), workspaces and invites, projects and workflow, sprints and issues (assign, priority, move, comment, upload), webhooks (failed delivery, Redeliver), Stripe sandbox checkout, reports and notifications ([TEST_RESULTS.md §4b](TEST_RESULTS.md#4b-browser-end-to-end-tests-playwright-77)) |
| Load | **k6** (`load/k6-api.js`) | 1 → 50 concurrent signed-in users with think time: 0% errors, p95 71 ms ([§5a](TEST_RESULTS.md#5a-load-test-k6)) |
| Accessibility | Lighthouse in light and dark mode, plus keyboard checks | 100 on every audited page ([§6a](TEST_RESULTS.md#6a-frontend-performance-and-accessibility-lighthouse)) |
| Fresh clone test | manual, before submission ([TEST_RESULTS.md §4a](TEST_RESULTS.md#4a-fresh-clone-test)) | clean clone with `.env.example`, `build --no-cache`, empty volumes under a separate compose project (`-p flowboard-fresh`): 84 migrations, demo data loaded, smoke test 26/26 |
| Browser checks | headless Chromium during development | demo login, dashboard, board drag → persisted status, backlog drag → persisted sprint, create via `C`, palette search, viewer read-only, workspace switching, dark mode, billing, a real Stripe test payment, the home page (desktop + mobile, light + dark, no horizontal overflow, signed-in redirect) |

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
| + | Public home page at `/` with features, pricing and FAQ ([9.1](#91-routing)) | ✅ |
| + | API hardening review of all 88 endpoints, group by group: auth, tenants, projects, issues, automation, billing (sections [6](#6-domain-rules)–[8a](#8a-billing-stripe)) | ✅ |
| + | Frontend unit and component tests with Vitest + React Testing Library, run in CI ([11](#11-testing-strategy)) | ✅ |
| + | Security hardening: production configuration, refresh token in an httpOnly cookie, expired-token cleanup, and a security audit that removed secrets from the logs ([7.1](#71-browser-sessions-refresh-token-in-an-httponly-cookie), [7.2](#72-security-hardening-production-configuration-and-logging)) | ✅ |
| + | Browser E2E (Playwright), load (k6) and Lighthouse testing; fixed what they found: a board render loop, per-IP refresh limits hitting shared office IPs (and a spoofable client IP), the webhook delivery UI, accessibility ([TEST_RESULTS.md §8](TEST_RESULTS.md#8-issues-found-by-these-tests-all-fixed)) | ✅ |
| + | Schema review of all 21 tables: DB-enforced integrity, lost-update fixes, async workspace deletion, measured indexes ([5](#5-data-model), [6](#6-domain-rules)) | ✅ |

Possible next steps: more frontend tests (board drag-and-drop, issue drawer) and a linter in CI, splitting the
main JS bundle (mobile Lighthouse performance is 59–75 because of it), running the Playwright suite in CI,
paginating the project-wide issue list (it returns up to 1,000 rows at once), an HTTPS reverse proxy (e.g. Caddy) in the production compose file,
running `scripts/nginx_security_test.sh` in CI, a Redis password in production (defence in depth; Redis is
already internal-only), pinning Celery's JSON serializer explicitly, and `CONCURRENTLY` index builds for large databases.
