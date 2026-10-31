# FlowBoard: multi-tenant project management SaaS

A Jira-like platform where every company gets its own isolated workspace with projects, Kanban and
scrum boards, sprints, custom workflows and billing.

**Stack:** Django REST Framework · React 19 + TypeScript (Vite, pnpm) · PostgreSQL · Celery + Redis ·
Stripe Billing · Docker · GitHub Actions

| 📄 Doc | What's inside |
|---|---|
| **README.md** (this file) | What it is, how to run it, demo accounts, project status |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, multi-tenancy, data model, auth & roles, frontend architecture, roadmap |
| [docs/API_TEST.md](docs/API_TEST.md) | Testing the API with Swagger / curl / PowerShell, endpoint reference, security scenarios, automated tests |

---

## Build progress

| Phase | Scope | Status |
|---|---|---|
| 1 | Tenant isolation strategy + data models + Faker seed data | ✅ done |
| 2 | REST API (DRF) + JWT auth + role permissions | ✅ done |
| 3 | React UI + drag-and-drop Kanban | ✅ done |
| 4 | Custom workflows, comments, attachments, audit log | ⏳ next |
| 5 | Webhooks + Celery background jobs (notifications, reports) | ⏳ |
| 6 | Stripe Billing (test mode) + plan limits | ⏳ |
| 7 | Docker images + GitHub Actions CI/CD | ⏳ |

## Features (so far)

**Multi-tenancy & security**
- Every company is an isolated **workspace**. Data is separated with a `workspace_id` on every row,
  enforced at the request, query and write layers ([details](docs/ARCHITECTURE.md#4-multi-tenancy)).
- Other tenants' data is invisible: their workspaces and records return **404**, and foreign ids in
  payloads are rejected.
- **JWT** auth with rotating refresh tokens, logout blacklisting and login throttling.
- **Roles**: owner › admin › member › viewer. The UI mirrors what each role can do.
- Invitations by link (7-day expiry), and one user can belong to several workspaces.

**Project management**
- Projects with keys (`WEB`), per-project workflows (To Do → In Progress → In Review → Done) and boards.
- **Drag-and-drop Kanban**: move across and within columns; the card moves instantly and snaps back if
  the server rejects the move. Also WIP limits, quick-add and filters.
- **Backlog & sprints**: drag issues between sprints and the backlog; plan, start and complete sprints
  (unfinished work carries over).
- Issues: epics, stories, tasks, bugs, sub-tasks, priorities, story points, due dates, labels, markdown
  descriptions, and keys like `WEB-12`.
- **Issue drawer** with inline editing, and a deep link for every issue (`?issue=WEB-12`).
- **Dashboard**: KPIs, created-vs-resolved trend, status and type charts, sprint progress, team workload.
- Issues table across projects with search, filters, sorting and pagination.
- `Ctrl/⌘ K` command palette, `C` to create an issue, light/dark/system theme, responsive layout.

---

## Quick start

**Prerequisites:** Docker Desktop (running), Python 3.12+, Node 20+, pnpm.

```bash
# 1. config + databases
cp .env.example .env
docker compose up -d db redis              # Postgres :5432, Redis :6380

# 2. backend (terminal 1)
cd backend
python -m venv .venv
.venv\Scripts\activate                     # Windows  (source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
python manage.py migrate
python manage.py seed_demo --reset         # demo data: 3 companies, 7 projects, ~336 issues
python manage.py runserver                 # http://127.0.0.1:8000

# 3. frontend (terminal 2)
cd frontend
pnpm install
pnpm dev                                   # http://localhost:5173
```

Open **http://localhost:5173** and click one of the **one-click demo accounts** on the login page.

| URL | What |
|---|---|
| http://localhost:5173 | The app |
| http://127.0.0.1:8000/api/docs/ | Swagger UI (interactive API docs) |
| http://127.0.0.1:8000/api/schema/ | OpenAPI 3 schema (import into Postman/Insomnia) |
| http://127.0.0.1:8000/admin/ | Django admin (`admin@flowboard.test` / `Demo@1234`) |
| http://127.0.0.1:8000/api/health/ | Health check |

### Demo accounts (password `Demo@1234`)

| Workspace | Plan | Accounts | Projects |
|---|---|---|---|
| Acme Corp (`acme`) | Pro | `owner@acme.test`, `admin@acme.test`, `viewer@acme.test` | WEB, MOB, API |
| Globex Industries (`globex`) | Free | `owner@globex.test`, `admin@globex.test`, `viewer@globex.test` | CP, DATA |
| Initech Labs (`initech`) | Enterprise | `owner@initech.test`, `admin@initech.test`, `viewer@initech.test` | PAY, OPS |
| Acme + Globex | n/a | `alex@flowboard.test`, a member of two workspaces (try the workspace switcher) | n/a |

Things to try: drag a card to **Done** on the board, drag issues from the backlog into the planned
sprint, press `Ctrl+K` and search, log in as a **viewer** to see the read-only UI, and invite someone
from **Members** (then open the invite link in a private window).

---

## Project structure

```
backend/                Django project (config/) + apps: core, accounts, tenants, projects, issues
frontend/               React + TypeScript SPA (Vite, pnpm)
docs/                   ARCHITECTURE.md, API_TEST.md
docker-compose.yml      Postgres + Redis for local development
.env.example            every setting with a dev default
```

The architecture doc has the full tree and what each app and module owns.

## Roles at a glance

| Action | Viewer | Member | Admin | Owner |
|---|:-:|:-:|:-:|:-:|
| See everything in the workspace | ✅ | ✅ | ✅ | ✅ |
| Create / edit / move issues, sprints, labels | | ✅ | ✅ | ✅ |
| Delete an issue | | own | ✅ | ✅ |
| Create / edit / archive / delete projects, WIP limits | | | ✅ | ✅ |
| Invite, change roles, remove members | | | ✅ | ✅ |
| Delete the workspace | | | | ✅ |

## API in one minute

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8000/api/auth/login/ -H "Content-Type: application/json" \
  -d '{"email":"owner@acme.test","password":"Demo@1234"}' | python -c "import sys,json;print(json.load(sys.stdin)['access'])")

curl "http://127.0.0.1:8000/api/issues/?project=WEB&sprint=active" \
  -H "Authorization: Bearer $TOKEN" -H "X-Workspace: acme"
```

Every workspace-scoped call needs `Authorization: Bearer <access>` **and** `X-Workspace: <slug>`.
The full walkthrough, endpoint table and security scenarios are in [docs/API_TEST.md](docs/API_TEST.md).

## Tests

```bash
cd backend && pytest        # 57 tests on PostgreSQL: tenancy, permissions, API, sprints, invitations
cd frontend && pnpm build   # strict TypeScript check + production build
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `connection refused` to Postgres | Start **Docker Desktop**, then `docker compose up -d db redis` |
| Redis port already allocated | Set `REDIS_HOST_PORT` (and `REDIS_URL`) in `.env` to a free port; the default is 6380 |
| `pnpm install` complains about ignored build scripts | Already handled in `frontend/pnpm-workspace.yaml` (`allowBuilds: esbuild`); for a new package run `pnpm approve-builds <pkg>` |
| UI says "Can't reach the server" | Django isn't running on :8000 (Vite proxies `/api` there) |
| Demo login stopped working | Re-run `python manage.py seed_demo --reset` |
| Logged out unexpectedly | Refresh tokens last 7 days, and every refresh rotates them; just log in again |
