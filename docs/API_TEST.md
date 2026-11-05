# FlowBoard API testing guide

How to test the FlowBoard REST API by hand (Swagger UI, curl, PowerShell) and with the automated
test suite. Every response shown here was captured from the running app with the demo seed data.
IDs on your machine will differ; keys such as `WEB-4` and slugs such as `acme` stay the same.

- [1. Before you start](#1-before-you-start)
- [2. Three ways to test](#2-three-ways-to-test)
- [3. Conventions every request follows](#3-conventions-every-request-follows)
- [4. Walkthrough with curl](#4-walkthrough-with-curl)
- [5. Endpoint reference](#5-endpoint-reference)
- [6. Security test scenarios](#6-security-test-scenarios)
- [7. Error reference](#7-error-reference)
- [8. Automated tests](#8-automated-tests)
- [9. Troubleshooting](#9-troubleshooting)

---

## 1. Before you start

```bash
docker compose up -d db redis                       # Postgres + Redis
cd backend && .venv\Scripts\activate                # or: source .venv/bin/activate
python manage.py migrate
python manage.py seed_demo --reset                  # predictable demo data
python manage.py runserver                          # http://127.0.0.1:8000
```

Check it's alive:

```bash
curl http://127.0.0.1:8000/api/health/
# {"status": "ok", "database": "ok"}
```

**Base URL:** `http://127.0.0.1:8000/api`. Through the frontend dev server, `http://localhost:5173/api`
works too, because Vite proxies it.

**Using Docker instead?** `docker compose up -d --build` runs everything (migrations and demo data included).
Then the base URL is **`http://localhost:8080/api`** (nginx → gunicorn) and every example below works with
that prefix. Run management commands with `docker compose exec backend python manage.py …`, and see emails in
`docker compose logs -f worker`.

### Demo accounts (password `Demo@1234` for all)

| Account | Workspace (slug) | Role | Use it to test |
|---|---|---|---|
| `owner@acme.test` | Acme Corp (`acme`) | owner | everything, including deleting the workspace |
| `admin@acme.test` | Acme Corp (`acme`) | admin | projects, members, invitations |
| `viewer@acme.test` | Acme Corp (`acme`) | viewer | read-only (writes must return 403) |
| `owner@globex.test` | Globex (`globex`) | owner | a second, isolated tenant |
| `owner@initech.test` | Initech (`initech`) | owner | a third tenant |
| `alex@flowboard.test` | `acme` + `globex` | member | one user in two workspaces |
| `admin@flowboard.test` | none | Django superuser | `/admin/` only |

Acme's projects are `WEB` (Website Revamp), `MOB` (Mobile App) and `API` (Platform API). Each one has
4 statuses (To Do, In Progress, In Review, Done), sprints 1–2 closed, sprint 3 active and sprint 4 planned.

---

## 2. Three ways to test

### A. Swagger UI (easiest)

1. Open **http://127.0.0.1:8000/api/docs/**. It needs no login, but it loads its assets from a CDN, so you
   need internet access.
2. Run `POST /api/auth/login/` → **Try it out** with `{"email": "owner@acme.test", "password": "Demo@1234"}`.
3. Copy the `access` value, click **Authorize** (top right), paste it into **jwtAuth** (no `Bearer ` prefix).
4. Workspace-scoped endpoints show an **X-Workspace** header field. Enter `acme`.

The raw OpenAPI 3 schema is at `/api/schema/`. Import that URL into **Postman** or **Insomnia** to get
every endpoint generated as a collection.

### B. curl (Git Bash, macOS, Linux)

The walkthrough in [section 4](#4-walkthrough-with-curl) is copy-paste ready. It uses `python` to pull
the token out of the JSON, so `jq` isn't required.

### C. PowerShell (Windows)

```powershell
$base  = "http://127.0.0.1:8000/api"
$login = Invoke-RestMethod -Method Post -Uri "$base/auth/login/" -ContentType "application/json" `
         -Body '{"email":"owner@acme.test","password":"Demo@1234"}'
$h = @{ Authorization = "Bearer $($login.access)"; "X-Workspace" = "acme" }

Invoke-RestMethod -Uri "$base/projects/" -Headers $h | Select-Object key, name, issue_count
Invoke-RestMethod -Uri "$base/issues/?project=WEB&sprint=active" -Headers $h | Select-Object key, title, status_category

# POST with a body
$body = @{ project = 15; title = "Created from PowerShell"; issue_type = "task" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/issues/" -Headers $h -ContentType "application/json" -Body $body
```

> In Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe` if you want real
> curl, or run the curl examples in Git Bash.

---

## 3. Conventions every request follows

### Headers

| Header | When | Example |
|---|---|---|
| `Authorization: Bearer <access>` | every endpoint except register/login/refresh/logout, invitation preview, health, docs | `Bearer eyJhbGci…` |
| `X-Workspace: <slug>` | every **workspace-scoped** endpoint (see the table in section 5) | `X-Workspace: acme` |
| `Content-Type: application/json` | requests with a body | |

`?workspace=acme` as a query parameter works as a fallback for `X-Workspace`.

### Tokens

| Token | Lifetime | Notes |
|---|---|---|
| access | 30 minutes | send as Bearer |
| refresh | 7 days | **rotates**: every `/auth/refresh/` returns a new refresh token and blacklists the old one |

### Lookups

- Projects are addressed by **key**: `/api/projects/WEB/`
- Issues are addressed by **key**: `/api/issues/WEB-12/` (case-insensitive, so `web-12` works too)
- Everything else uses its numeric **id**: `/api/sprints/60/`, `/api/members/12/`

### Pagination (opt-in)

Lists return a **plain JSON array** by default. Add `?page=N` (and optionally `page_size`, max 500)
to get a paginated envelope:

```json
{ "count": 16, "next": "http://127.0.0.1:8000/api/issues/?page=2&page_size=2&project=WEB&sprint=active",
  "previous": null, "results": [ … ] }
```

### Status codes

| Code | Meaning in FlowBoard |
|---|---|
| 200 / 201 / 204 | OK / created / deleted |
| 205 | logged out (refresh token blacklisted) |
| 400 | validation error, missing `X-Workspace`, cross-tenant id, disallowed transition |
| 401 | missing/expired/blacklisted token, wrong credentials |
| 403 | authenticated member, but the role is too low (e.g. viewer writing) |
| 404 | not found **or not yours**: other tenants' workspaces and rows are indistinguishable from missing ones |
| 202 | accepted for background processing (reports, webhook test, invitation resend) |
| 409 | database constraint conflict (rare race, e.g. two sprints started at once) |
| 429 | rate limit on `auth/login/` and `auth/register/` (20 requests/minute) |

---

## 4. Walkthrough with curl

Run these in order in **one** Git Bash / macOS / Linux terminal; later steps reuse the variables.

```bash
API=http://127.0.0.1:8000/api
json() { python -c "import sys, json; print(json.load(sys.stdin)$1)"; }   # tiny JSON helper
```

### 4.1 Log in

```bash
LOGIN=$(curl -s -X POST $API/auth/login/ -H "Content-Type: application/json" \
  -d '{"email":"owner@acme.test","password":"Demo@1234"}')
TOKEN=$(echo "$LOGIN" | json "['access']")
REFRESH=$(echo "$LOGIN" | json "['refresh']")
AUTH="Authorization: Bearer $TOKEN"
WS="X-Workspace: acme"
```

Response `200` (tokens shortened):

```json
{
  "refresh": "eyJhbGciOiJIUzI1NiIs…",
  "access": "eyJhbGciOiJIUzI1NiIs…",
  "user": {
    "id": 47, "email": "owner@acme.test", "first_name": "Danielle", "last_name": "Johnson",
    "display_name": "Danielle Johnson", "initials": "DJ", "avatar_color": "#6366f1",
    "job_title": "CTO", "is_staff": false, "date_joined": "2026-10-31T19:00:18.538341Z"
  }
}
```

Email is case-insensitive (`OWNER@acme.test` works). Wrong password → `401 {"detail": "No active account found with the given credentials"}`.

### 4.2 Who am I, and which workspaces can I use?

```bash
curl -s $API/auth/me/ -H "$AUTH"
curl -s $API/workspaces/ -H "$AUTH"          # no X-Workspace needed: this is how you discover slugs
```

```json
[
  {
    "id": 7, "name": "Acme Corp", "slug": "acme", "plan": "pro",
    "owner": { "id": 47, "email": "owner@acme.test", "display_name": "Danielle Johnson", "…": "…" },
    "role": "owner", "member_count": 8, "project_count": 3,
    "created_at": "2026-10-31T19:00:18.875361Z"
  }
]
```

### 4.3 Projects

```bash
curl -s $API/projects/ -H "$AUTH" -H "$WS"                 # list (with statuses, board, active sprint, counts)
curl -s $API/projects/WEB/ -H "$AUTH" -H "$WS"             # one project, by key
```

```json
{
  "id": 15, "key": "WEB", "name": "Website Revamp", "description": "…", "color": "#6366f1",
  "lead": 47, "lead_detail": { "id": 47, "display_name": "Danielle Johnson", "…": "…" },
  "is_archived": false, "created_at": "2026-10-31T19:00:20.910957Z",
  "statuses": [
    { "id": 57, "name": "To Do",       "category": "todo",        "color": "#64748b", "position": 0 },
    { "id": 58, "name": "In Progress", "category": "in_progress", "color": "#3b82f6", "position": 1 },
    { "id": 59, "name": "In Review",   "category": "in_progress", "color": "#a855f7", "position": 2 },
    { "id": 60, "name": "Done",        "category": "done",        "color": "#22c55e", "position": 3 }
  ],
  "board": { "id": 15, "project": 15, "name": "WEB board", "board_type": "scrum", "wip_limits": {} },
  "active_sprint": { "id": 59, "name": "WEB Sprint 3", "state": "active", "start_date": "2026-10-26", "end_date": "2026-11-08" },
  "enforce_transitions": false, "issue_count": 48, "done_count": 15
}
```

Save the ids you'll need:

```bash
PROJECT_ID=$(curl -s $API/projects/WEB/ -H "$AUTH" -H "$WS" | json "['id']")
TODO=$(curl -s $API/projects/WEB/ -H "$AUTH" -H "$WS" | json "['statuses'][0]['id']")
IN_PROGRESS=$(curl -s $API/projects/WEB/ -H "$AUTH" -H "$WS" | json "['statuses'][1]['id']")
DONE=$(curl -s $API/projects/WEB/ -H "$AUTH" -H "$WS" | json "['statuses'][3]['id']")
```

Create, update, archive and delete (admin or owner):

```bash
# create: also scaffolds a 4-status workflow and a board
curl -s -X POST $API/projects/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"name":"Data Platform","key":"dp","board_type":"kanban","color":"#14b8a6"}'
# → 201, key normalised to "DP"; "statuses" has 4 entries and "board.board_type" is "kanban"

curl -s -X PATCH $API/projects/DP/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"description":"Warehouse + ETL","is_archived":true}'

curl -s -X DELETE $API/projects/DP/ -H "$AUTH" -H "$WS" -o /dev/null -w "%{http_code}\n"   # 204
```

Set a WIP limit on a board column (admin): `{"<status id>": max}`:

```bash
curl -s -X PATCH $API/boards/15/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d "{\"wip_limits\": {\"$IN_PROGRESS\": 3}}"
```

### 4.4 Issues

```bash
curl -s "$API/issues/?project=WEB&sprint=active" -H "$AUTH" -H "$WS"          # the board's data
curl -s "$API/issues/?project=WEB&sprint=backlog&ordering=rank" -H "$AUTH" -H "$WS"
curl -s "$API/issues/?assignee=me&status_category=todo,in_progress" -H "$AUTH" -H "$WS"
curl -s "$API/issues/?search=checkout&page=1&page_size=10" -H "$AUTH" -H "$WS"
curl -s $API/issues/WEB-4/ -H "$AUTH" -H "$WS"                               # detail (+ description, children)
```

List item shape (the detail view adds `description` and `children`):

```json
{
  "id": 677, "key": "WEB-4", "number": 4, "project": 15, "project_key": "WEB",
  "title": "Race condition in Kanban drag & drop in admin panel",
  "issue_type": "bug", "priority": 2, "status": 57, "status_category": "todo",
  "sprint": 59, "parent": null, "parent_summary": null,
  "assignee": null, "assignee_detail": null,
  "reporter_detail": { "id": 49, "email": "erica.mcclain@acme.test", "display_name": "Erica Mcclain", "…": "…" },
  "story_points": null, "due_date": "2026-11-14", "rank": 1024.0, "labels": [],
  "resolved_at": null, "created_at": "2026-10-20T04:00:00Z", "updated_at": "2026-10-27T04:26:35.074167Z"
}
```

**Create.** `project` and `title` are required; everything else is optional. If you leave `status` out,
the issue gets the project's first status. The reporter is always the caller.

```bash
NEW=$(curl -s -X POST $API/issues/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d "{\"project\":$PROJECT_ID,\"title\":\"Docs: sample issue\",\"issue_type\":\"bug\",\"priority\":4,\"status\":$TODO,\"story_points\":3}")
KEY=$(echo "$NEW" | json "['key']"); echo $KEY          # e.g. WEB-49
```

Response `201`: the full issue, with `key` allocated (`WEB-49`), `rank` placed at the bottom of its
column, and `reporter_detail` set to you.

| Field | Type | Notes |
|---|---|---|
| `project` | id | required on create; can't change later |
| `title` | string ≤ 255 | required, not blank |
| `description` | markdown string | |
| `issue_type` | `epic` · `story` · `task` · `bug` · `subtask` | default `task` |
| `priority` | 1 Lowest … 5 Highest | default 3 |
| `status` | status id of the same project | default: first status |
| `sprint` | sprint id or `null` (backlog) | not a closed sprint |
| `parent` | issue id or `null` | must be an epic, unless the issue is a `subtask` |
| `assignee` | user id or `null` | must be a member of this workspace |
| `story_points` | int | |
| `due_date` | `YYYY-MM-DD` | |
| `labels` | `[label ids]` | same workspace only |

**Update** (partial):

```bash
curl -s -X PATCH $API/issues/$KEY/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"priority":5,"assignee":47,"labels":[]}'
```

**Move** (what drag-and-drop calls). Change the status and/or sprint, and slot the issue between two neighbours:

```bash
# to "In Progress", placed between two other issues
curl -s -X POST $API/issues/$KEY/move/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d "{\"status\":$IN_PROGRESS,\"prev_id\":677,\"next_id\":680}"

# from the backlog into sprint 60, at the top
curl -s -X POST $API/issues/$KEY/move/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"sprint":60,"prev_id":null,"next_id":null}'
```

| Body field | Meaning |
|---|---|
| `status` | optional new status id (checked against workflow transitions) |
| `sprint` | optional; include it to change the sprint (`null` = backlog), leave it out to keep the current one |
| `prev_id` | id of the issue now directly **above** (or `null`) |
| `next_id` | id of the issue now directly **below** (or `null`) |

The new rank is `(prev.rank + next.rank) / 2`. If the gap gets too small, the server re-spaces the
project's ranks automatically. Moving into a *done* status sets `resolved_at`.

**Delete** (the reporter or an admin):

```bash
curl -s -X DELETE $API/issues/$KEY/ -H "$AUTH" -H "$WS" -o /dev/null -w "%{http_code}\n"     # 204
```

### 4.5 Sprints

```bash
curl -s "$API/sprints/?project=WEB&state=planned,active" -H "$AUTH" -H "$WS"
```

```json
[
  { "id": 59, "project": 15, "name": "WEB Sprint 3", "goal": "…", "state": "active",
    "start_date": "2026-10-26", "end_date": "2026-11-08", "completed_at": null,
    "issue_count": 16, "done_count": 4, "total_points": 40, "done_points": 0 },
  { "id": 60, "project": 15, "name": "WEB Sprint 4", "goal": "…", "state": "planned",
    "start_date": "2026-11-09", "end_date": "2026-11-22", "completed_at": null,
    "issue_count": 7, "done_count": 0, "total_points": 23, "done_points": 0 }
]
```

Full lifecycle:

```bash
# create (name is optional → auto "WEB Sprint 5")
SPRINT=$(curl -s -X POST $API/sprints/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d "{\"project\":$PROJECT_ID,\"goal\":\"Ship onboarding\"}" | json "['id']")

# start: 400 while another sprint of the project is active
curl -s -X POST $API/sprints/$SPRINT/start/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"start_date":"2026-11-01","end_date":"2026-11-14"}'
# → 400 ["This project already has an active sprint. Complete it first."]

# complete the active sprint, moving unfinished issues into the new planned sprint (null = backlog)
curl -s -X POST $API/sprints/59/complete/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d "{\"move_open_issues_to\":$SPRINT}"
# → 200, "state": "closed", "completed_at" set. Done issues stay in the closed sprint.

curl -s -X POST $API/sprints/$SPRINT/start/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" -d '{}'
# → 200, starts today and ends 14 days later unless you send dates
```

Rules: only `planned` sprints start, only the `active` one completes, closed sprints are read-only,
an active sprint can't be deleted, and deleting a planned sprint sends its issues back to the backlog
(admin only).

### 4.6 Labels, members, invitations

```bash
curl -s $API/labels/ -H "$AUTH" -H "$WS"
curl -s -X POST $API/labels/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"name":"Customer-Facing","color":"#ec4899"}'          # name stored lower-case, unique per workspace

curl -s $API/members/ -H "$AUTH" -H "$WS"
curl -s -X PATCH $API/members/<membership id>/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"role":"admin"}'                                        # admin+; never "owner"
```

Invitation flow (admin creates it, then the invitee accepts):

```bash
INVITE=$(curl -s -X POST $API/invitations/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"email":"new.hire@example.test","role":"member"}')
echo "$INVITE"
```

```json
{
  "id": 1, "email": "docs.newhire@example.test", "role": "member",
  "invited_by": { "id": 47, "display_name": "Danielle Johnson", "…": "…" },
  "expires_at": "2026-11-07T19:05:21.510015Z",
  "accept_url": "http://localhost:5173/invite/BdUP0TnLiW5z5W02OTYIzxZM0AV2qE_pVyZgfHNbxSs",
  "created_at": "2026-10-31T19:05:21.510156Z"
}
```

```bash
INV_TOKEN=$(echo "$INVITE" | json "['accept_url'].rsplit('/', 1)[1]")

# public preview: no auth needed
curl -s $API/invitations/preview/$INV_TOKEN/
# {"email": "new.hire@example.test", "role": "member", "workspace": "Acme Corp", "workspace_slug": "acme",
#  "invited_by": "Danielle Johnson", "is_pending": true, "user_exists": false, "expires_at": "…"}

# new user: register with the token, which joins the workspace in the same request
curl -s -X POST $API/auth/register/ -H "Content-Type: application/json" \
  -d "{\"email\":\"new.hire@example.test\",\"password\":\"S3cure-pass!\",\"first_name\":\"New\",\"invite_token\":\"$INV_TOKEN\"}"
# → 201 {"user": {…}, "access": "…", "refresh": "…", "workspace": "acme"}

# an existing user accepts instead with: POST /invitations/accept/ {"token": "…"} (logged in as that email)
```

### 4.7 Dashboard

```bash
curl -s $API/dashboard/ -H "$AUTH" -H "$WS"
```

Returns `totals`, `by_category`, `by_type`, `by_priority`, `workload`, `trend` (14 days of
created/resolved), `projects`, `active_sprints`, `my_issues` and `recent`. Example `totals`:

```json
{ "total": 144, "done": 49, "in_progress": 37, "overdue": 12, "unassigned": 18,
  "mine_open": 10, "done_this_week": 14, "open": 95 }
```

### 4.8 Refresh, logout, password

```bash
NEW_TOKENS=$(curl -s -X POST $API/auth/refresh/ -H "Content-Type: application/json" -d "{\"refresh\":\"$REFRESH\"}")
# → 200 {"access": "…", "refresh": "…"}   (a NEW refresh token)

curl -s -X POST $API/auth/refresh/ -H "Content-Type: application/json" -d "{\"refresh\":\"$REFRESH\"}"
# → 401 {"detail": "Token is blacklisted", "code": "token_not_valid"}   (the old one was rotated out)

curl -s -X POST $API/auth/logout/ -H "Content-Type: application/json" \
  -d "{\"refresh\":\"$(echo "$NEW_TOKENS" | json "['refresh']")\"}" -o /dev/null -w "%{http_code}\n"   # 205

curl -s -X POST $API/auth/change-password/ -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"current_password":"Demo@1234","new_password":"N3w-pass-123"}' -o /dev/null -w "%{http_code}\n"  # 204
```

> Re-run `python manage.py seed_demo --reset` afterwards to restore the demo passwords and data.

### 4.9 Workflows

```bash
curl -s $API/projects/WEB/workflow/ -H "$AUTH" -H "$WS"       # any role
# {"name": "...", "enforce_transitions": false, "statuses": [...], "transitions": [{"from": 0, "to": 1}]}
```

`PUT` (admin) replaces the workflow. List order sets the status order, and transitions use **indexes into that
list**. A status with an `id` is kept, one without is created, and one left out is deleted. A status in use can't
be removed or change category. At least one `todo` and one `done` status are required.

```bash
WF=$(curl -s $API/projects/WEB/workflow/ -H "$AUTH" -H "$WS")
curl -s -X PUT $API/projects/WEB/workflow/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" -d "$WF"   # 200
```

### 4.10 Comments, attachments, activity

```bash
curl -s -X POST $API/issues/WEB-4/comments/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"body":"Please review @admin@acme.test"}'             # 201, mentions resolved to members
curl -s $API/issues/WEB-4/comments/ -H "$AUTH" -H "$WS"
curl -s $API/issues/WEB-4/activity/ -H "$AUTH" -H "$WS"

echo hello > note.txt
ATT=$(curl -s -X POST $API/issues/WEB-4/attachments/ -H "$AUTH" -H "$WS" -F "file=@note.txt;type=text/plain" | json "['id']")
curl -s $API/attachments/$ATT/download/ -H "$AUTH" -H "$WS"   # hello
curl -s -X DELETE $API/attachments/$ATT/ -H "$AUTH" -H "$WS" -o /dev/null -w "%{http_code}\n"   # 204
```

Allowed files: CSV, GIF, JPEG, Markdown, PDF, PNG, TXT, WebP, ZIP, up to 25 MB. Comment edits and deletes need
the author or an admin; attachment deletes need the uploader or an admin.

### 4.11 Webhooks (admin)

```bash
HOOK=$(curl -s -X POST $API/webhooks/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"name":"Receiver","url":"https://example.com/hook","events":["issue.created","issue.moved"]}' | json "['id']")
curl -s -X POST $API/webhooks/$HOOK/test/ -H "$AUTH" -H "$WS"           # 202, needs the worker
curl -s $API/webhooks/$HOOK/deliveries/ -H "$AUTH" -H "$WS"
curl -s -X POST $API/webhooks/$HOOK/rotate-secret/ -H "$AUTH" -H "$WS"
```

Events: `issue.created|updated|moved|commented|attached|detached|deleted`, or `*`. Each request carries
`X-FlowBoard-Event`, `X-FlowBoard-Delivery` and `X-FlowBoard-Signature: sha256=<HMAC of the raw body using the
secret>`. Failed deliveries retry up to 5 times with backoff. Outside `DEBUG`, targets must be HTTPS and public:
internal addresses are refused when created and when delivered.

### 4.12 Notifications

```bash
curl -s $API/notifications/ -H "$AUTH" -H "$WS"               # {"unread_count": 1, "results": [...]}
curl -s -X POST $API/notifications/<id>/read/ -H "$AUTH" -H "$WS"
curl -s -X POST $API/notifications/read-all/ -H "$AUTH" -H "$WS"
```

### 4.13 Reports (generate: member+; read: any role)

```bash
SPRINT3=$(curl -s "$API/sprints/?project=WEB&state=active" -H "$AUTH" -H "$WS" | json "[0]['id']")
R=$(curl -s -X POST $API/reports/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d "{\"report_type\":\"sprint_burndown\",\"sprint\":$SPRINT3}" | json "['id']")     # 202, state "pending"
curl -s $API/reports/$R/ -H "$AUTH" -H "$WS"                  # state "ready" once the worker has run it
curl -s $API/reports/$R/download/ -H "$AUTH" -H "$WS"         # CSV; 400 until ready
```

| `report_type` | Required | Result |
|---|---|---|
| `sprint_burndown` | `sprint` (started) | remaining points and issues per day, with the ideal line |
| `velocity` | `project` | points delivered per closed sprint (last 10), with the average |
| `workspace_summary` | none (default) | issue counts by status, priority and project |

### 4.14 Audit log (admin)

```bash
curl -s "$API/audit-log/?entity_type=sprint&project=WEB&page=1&page_size=20" -H "$AUTH" -H "$WS"
```

Filters: `entity_type`, `action`, `actor` (user id), `project` (key), `date_from`, `date_to`, `search`. The endpoint
is read-only.

### 4.15 Email

With the worker running, emails print in its terminal: invitations, mentions, new assignments, overdue reminders
and digests. Resend an invitation with `POST /invitations/{id}/resend/`. Opt out of notification emails with
`PATCH /auth/me/ {"email_notifications": false}`; invitations aren't affected. To run the daily jobs without waiting
for beat:

```bash
python manage.py shell -c "from apps.automation.tasks import create_overdue_reminders as o, create_daily_digests as d; o.delay(); d.delay()"
```

### 4.16 Billing (read: any role; payments: owner)

Needs Stripe **test** keys in `.env` and `python manage.py stripe_setup` run once (see the README). Without
keys, `GET /billing/` still works and reports `"stripe_configured": false`; the payment endpoints return 503.

```bash
GLOBEX="Authorization: Bearer $(curl -s -X POST $API/auth/login/ -H 'Content-Type: application/json' \
  -d '{"email":"owner@globex.test","password":"Demo@1234"}' | json "['access']")"
GWS="X-Workspace: globex"

curl -s $API/billing/ -H "$GLOBEX" -H "$GWS"
```

```json
{"plan": "free",
 "plans": [{"id": "free", "name": "Free", "price_monthly": 0, "projects": 3, "members": 5, "file_mb": 10, "features": […]},
           {"id": "pro", "name": "Pro", "price_monthly": 29, "projects": 20, "members": 50, "file_mb": 25, …},
           {"id": "enterprise", "name": "Enterprise", "price_monthly": 99, "projects": null, "members": null, "file_mb": 100, …}],
 "usage": {"projects": 2, "members": 8, "pending_invitations": 0},
 "can_manage": true, "stripe_configured": true, "has_billing_account": false, "subscription": null}
```

`null` means unlimited. Globex is a demo workspace on Free that already has 8 members, so it shows the "limits only
block adding more" rule: it keeps all 8, but a new invitation returns 402.

```bash
# owner: start an upgrade → open the returned URL, pay with 4242 4242 4242 4242
curl -s -X POST $API/billing/checkout/ -H "$GLOBEX" -H "$GWS" -H "Content-Type: application/json" -d '{"plan":"pro"}'
# → 200 {"url": "https://checkout.stripe.com/c/pay/cs_test_…"}
# {"plan":"free"} → 400 {"plan": "Choose a paid plan."}
# already subscribed → 400 "This workspace already has a subscription. Use Manage billing to change it."

# owner: Stripe Customer Portal (cards, invoices, plan change, cancel); needs a billing account (checkout once)
curl -s -X POST $API/billing/portal/ -H "$GLOBEX" -H "$GWS"
# → 200 {"url": "https://billing.stripe.com/p/session/test_…"}

# owner: pull the latest subscription from Stripe (use this when webhooks can't reach you)
curl -s -X POST $API/billing/sync/ -H "$GLOBEX" -H "$GWS"
# → 200 same shape as GET /billing/, with "plan": "pro" after a successful payment
```

**Plan limits** return **402**:

```bash
# on Free (3 projects): the 4th active project
curl -s -X POST $API/projects/ -H "$GLOBEX" -H "$GWS" -H "Content-Type: application/json" -d '{"name":"Four","key":"FOUR"}'
# → 402 {"detail": "Your plan allows 3 active projects. Upgrade or archive a project to add another.",
#        "code": "plan_limit_reached", "limit": "projects", "current_plan": "free"}
```

| Limit | Checked on | `limit` value |
|---|---|---|
| Active projects | `POST /projects/`, un-archiving with `PATCH {"is_archived": false}` | `projects` |
| Members + pending invitations | `POST /invitations/` | `members` |
| File size | `POST /issues/{key}/attachments/` | `file_size` |

**Stripe webhook:** `POST /billing/webhook/` is called by Stripe, not by users. Forward events locally with
`stripe listen --forward-to localhost:8000/api/billing/webhook/` (Docker: port 8080) and put the printed
`whsec_…` in `STRIPE_WEBHOOK_SECRET`. Handled events: `checkout.session.completed`, `customer.subscription.*`
and `invoice.payment_failed` (notifies the owner). Each event id is processed once; a repeat returns
`{"received": true, "duplicate": true}`.

---

## 5. Endpoint reference

**WS?** = needs `X-Workspace`. **Min role** applies inside that workspace.

| Method & path | WS? | Min role | Purpose |
|---|:-:|---|---|
| `GET /health/` | | public | liveness + DB check |
| `POST /auth/register/` | | public | sign up (+ `workspace_name` or `invite_token`) · throttled |
| `POST /auth/login/` | | public | JWT pair + user · throttled |
| `POST /auth/refresh/` | | public | rotate tokens |
| `POST /auth/logout/` | | public | blacklist a refresh token → 205 |
| `GET/PATCH /auth/me/` | | logged in | profile (`first_name`, `last_name`, `job_title`, `avatar_color`) |
| `POST /auth/change-password/` | | logged in | → 204 |
| `GET/POST /workspaces/` | | logged in | my workspaces (with my role) / create one (I become owner) |
| `GET /workspace/` | ✅ | viewer | current workspace |
| `PATCH /workspace/` | ✅ | admin | rename |
| `DELETE /workspace/` | ✅ | owner | delete everything in it |
| `GET /members/` | ✅ | viewer | list (`?search=`) |
| `PATCH /members/{id}/` | ✅ | admin | change role (not owner, not yourself) |
| `DELETE /members/{id}/` | ✅ | admin, or yourself | remove member / leave (owner can't be removed) |
| `GET/POST /invitations/` | ✅ | admin | pending invitations / invite |
| `DELETE /invitations/{id}/` | ✅ | admin | revoke |
| `GET /invitations/preview/{token}/` | | public | what an invite link is for |
| `POST /invitations/accept/` | | logged in | join (email must match) |
| `GET /projects/` · `GET /projects/{key}/` | ✅ | viewer | `?search=`, `?is_archived=` |
| `POST/PATCH/DELETE /projects/…` | ✅ | admin | create (scaffolds workflow + board), edit, archive, delete |
| `GET /boards/` · `GET /boards/{id}/` | ✅ | viewer | `?project=<id>` |
| `PATCH /boards/{id}/` | ✅ | admin | `wip_limits` |
| `GET /sprints/` · `GET /sprints/{id}/` | ✅ | viewer | `?project=<id or key>&state=planned,active,closed` |
| `POST/PATCH /sprints/…` | ✅ | member | create / edit (not closed) |
| `POST /sprints/{id}/start/` | ✅ | member | `start_date`, `end_date`, `goal` (all optional) |
| `POST /sprints/{id}/complete/` | ✅ | member | `move_open_issues_to`: sprint id or null |
| `DELETE /sprints/{id}/` | ✅ | admin | not the active sprint |
| `GET /issues/` · `GET /issues/{key}/` | ✅ | viewer | filters below |
| `POST/PATCH /issues/…` | ✅ | member | create / partial update |
| `POST /issues/{key}/move/` | ✅ | member | drag-and-drop |
| `DELETE /issues/{key}/` | ✅ | member (own) / admin | |
| `GET /labels/` · `POST/PATCH /labels/…` | ✅ | viewer / member | |
| `DELETE /labels/{id}/` | ✅ | admin | |
| `GET /dashboard/` | ✅ | viewer | aggregated stats |
| `GET /projects/{key}/workflow/` | ✅ | viewer | statuses + transitions |
| `PUT /projects/{key}/workflow/` | ✅ | admin | replace the workflow |
| `GET/POST /issues/{key}/comments/` | ✅ | viewer / member | list / add |
| `PATCH/DELETE /issues/{key}/comments/{id}/` | ✅ | author or admin | edit / delete |
| `GET/POST /issues/{key}/attachments/` | ✅ | viewer / member | list / upload (multipart) |
| `GET /attachments/{id}/download/` | ✅ | viewer | download |
| `DELETE /attachments/{id}/` | ✅ | uploader or admin | delete |
| `GET /issues/{key}/activity/` | ✅ | viewer | issue history |
| `/webhooks/` CRUD · `POST /webhooks/{id}/test/` · `POST /webhooks/{id}/rotate-secret/` · `GET /webhooks/{id}/deliveries/` | ✅ | admin | webhooks |
| `GET /notifications/` · `POST /notifications/{id}/read/` · `POST /notifications/read-all/` | ✅ | viewer | your own notifications |
| `GET /reports/` · `GET /reports/{id}/` · `GET /reports/{id}/download/` | ✅ | viewer | read / CSV |
| `POST /reports/` | ✅ | member | generate |
| `GET /audit-log/` | ✅ | admin | workspace history |
| `POST /invitations/{id}/resend/` | ✅ | admin | email again |
| `GET /billing/` | ✅ | viewer | plan, plan catalog, usage, subscription status |
| `POST /billing/checkout/` | ✅ | owner | `{"plan": "pro" \| "enterprise"}` → Stripe Checkout URL |
| `POST /billing/portal/` | ✅ | owner | Stripe Customer Portal URL |
| `POST /billing/sync/` | ✅ | owner | re-read the subscription from Stripe |
| `POST /billing/webhook/` | | Stripe signature | Stripe events (not in Swagger) |
| `GET /schema/` · `GET /docs/` | | public | OpenAPI 3 + Swagger UI |

### Issue list filters

| Param | Values | Example |
|---|---|---|
| `project` | id or key | `project=WEB` |
| `sprint` | id, `active`, `backlog` | `sprint=active` |
| `assignee` | `me`, `none`, user id(s) | `assignee=47,52` |
| `status` | status id(s) | `status=57,58` |
| `status_category` | `todo`, `in_progress`, `done` | `status_category=todo,in_progress` |
| `issue_type` / `exclude_type` | type(s) | `exclude_type=epic` |
| `priority` | 1–5 (comma list) | `priority=4,5` |
| `label` | label id | `label=9` |
| `parent` | issue id | children of an epic |
| `overdue` | `true` | past due and not done |
| `search` | text | matches key, title and description |
| `ordering` | `rank`, `created_at`, `updated_at`, `priority`, `due_date`, `number`, `story_points` (prefix `-` for descending) | `ordering=-priority` |
| `page`, `page_size` | ints (max 500) | `page=2&page_size=25` |

---

## 6. Security test scenarios

These are the checks that prove tenant isolation and role permissions. Each one is also covered by an
automated test (see [section 8](#8-automated-tests)).

```bash
# tokens for the other actors
login() { curl -s -X POST $API/auth/login/ -H "Content-Type: application/json" \
  -d "{\"email\":\"$1\",\"password\":\"Demo@1234\"}" | json "['access']"; }
VIEWER="Authorization: Bearer $(login viewer@acme.test)"
GLOBEX="Authorization: Bearer $(login owner@globex.test)"
```

| # | Scenario | Request | Expected |
|---|---|---|---|
| 1 | No token | `curl $API/projects/ -H "$WS"` | **401** `Authentication credentials were not provided.` |
| 2 | No workspace header | `curl $API/projects/ -H "$AUTH"` | **400** `{"workspace": "The X-Workspace header is required."}` |
| 3 | Someone else's workspace | `curl $API/projects/ -H "$AUTH" -H "X-Workspace: globex"` | **404** `Workspace not found.` (not 403: it doesn't confirm the workspace exists) |
| 4 | Another tenant's issue key | `curl $API/issues/WEB-1/ -H "$GLOBEX" -H "X-Workspace: globex"` | **404** `No Issue matches the given query.` Globex has no WEB project, so Acme's WEB-1 is invisible. (Two tenants *can* both own a `WEB-1`; each sees only its own.) |
| 5 | Foreign id in a payload | create an Acme issue with `"status": <a Globex status id>` | **400** `{"status": ["Invalid pk \"69\" - object does not exist."]}` |
| 6 | Assign a non-member | `"assignee": <Globex owner's user id>` | **400** on `assignee` |
| 7 | Viewer writes | `curl -X POST $API/issues/ -H "$VIEWER" -H "$WS" …` | **403** `Your role in this workspace does not allow this action.` |
| 8 | Member creates a project | any member token → `POST /projects/` | **403** |
| 9 | Admin deletes the workspace | admin token → `DELETE /workspace/` | **403** (owner only) |
| 10 | Promote to owner | admin → `PATCH /members/{id}/ {"role":"owner"}` | **400** `Ownership can't be assigned here.` |
| 11 | Reuse a rotated refresh token | see 4.8 | **401** `Token is blacklisted` |
| 12 | Accept someone else's invite | logged in as a different email → `POST /invitations/accept/` | **403** |
| 13 | Disallowed workflow transition | with `enforce_transitions` on, move To Do → Done without a rule | **400** `Transition 'To Do' → 'Done' is not allowed.` |
| 14 | Brute-force login | > 20 logins/minute from one client | **429** |
| 15 | Another tenant's attachment or report | their id on `/attachments/{id}/download/` or `/reports/{id}/download/` | **404** |
| 16 | Non-admin reads the audit log or webhooks | member token | **403** |
| 17 | Webhook to an internal address | `https://169.254.169.254/` with `DEBUG=False` | **400** |
| 18 | Write to an archived project's issues | `PATCH` or `move` | **400** `This project is archived…` |
| 19 | Upload a blocked file type | `run.html` | **400** |
| 20 | Non-owner starts a payment | admin or viewer → `POST /billing/checkout/` (or `/portal/`, `/sync/`) | **403** |
| 21 | Exceed a plan limit | 4th project on Free, invite past the member cap, file over the plan size | **402** `plan_limit_reached` |
| 22 | Forged Stripe webhook | `POST /billing/webhook/` without a valid `Stripe-Signature` | **400** `Invalid signature.` (503 when no webhook secret is set) |
| 23 | Replayed Stripe event | the same signed event twice | second → **200** `{"received": true, "duplicate": true}`, nothing applied twice |

Quick run of 1–3 and 7:

```bash
curl -s -o /dev/null -w "1: %{http_code}\n" $API/projects/ -H "$WS"
curl -s -o /dev/null -w "2: %{http_code}\n" $API/projects/ -H "$AUTH"
curl -s -o /dev/null -w "3: %{http_code}\n" $API/projects/ -H "$AUTH" -H "X-Workspace: globex"
curl -s -o /dev/null -w "7: %{http_code}\n" -X POST $API/issues/ -H "$VIEWER" -H "$WS" \
  -H "Content-Type: application/json" -d "{\"project\":$PROJECT_ID,\"title\":\"nope\"}"
# 1: 401   2: 400   3: 404   7: 403
```

Scenario 5 in full (a Globex status id inside an Acme request):

```bash
GSTATUS=$(curl -s $API/projects/ -H "$GLOBEX" -H "X-Workspace: globex" | json "[0]['statuses'][0]['id']")
curl -s -X POST $API/issues/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d "{\"project\":$PROJECT_ID,\"title\":\"x\",\"status\":$GSTATUS}"
# {"status":["Invalid pk \"69\" - object does not exist."]}
```

---

## 7. Error reference

Errors are always JSON. There are two shapes:

```json
{ "detail": "Your role in this workspace does not allow this action." }
```

```json
{ "title": ["This field may not be blank."], "key": ["This key is already used by another project."] }
```

Validation errors are keyed by field (`non_field_errors` or `detail` for whole-object problems).
Model-level tenant guards that fire below the serializer (e.g. a cross-workspace label attached
through M2M) are converted to the same `400` format. Database constraint races become `409`, never `500`.

| Example | Status | Body |
|---|---|---|
| bad credentials | 401 | `{"detail": "No active account found with the given credentials"}` |
| expired/invalid access token | 401 | `{"detail": "Given token not valid for any token type", "code": "token_not_valid", "messages": [{"token_class": "AccessToken", "token_type": "access", "message": "Token is invalid"}]}` |
| blank title | 400 | `{"title": ["This field may not be blank."]}` |
| duplicate project key | 400 | `{"key": ["This key is already used by another project."]}` |
| status from another project | 400 | `{"status": ["This status belongs to a different project."]}` |
| add to closed sprint | 400 | `{"sprint": ["Issues can't be added to a closed sprint."]}` |
| non-epic parent | 400 | `{"parent": ["Only sub-tasks can have a non-epic parent."]}` |
| second active sprint | 400 | `["This project already has an active sprint. Complete it first."]` |
| delete active sprint | 400 | `["Complete the sprint before deleting it."]` |
| remove the owner | 403 | `{"detail": "The workspace owner can't be removed."}` |
| plan limit reached | 402 | `{"detail": "Your plan allows 3 active projects. …", "code": "plan_limit_reached", "limit": "projects", "current_plan": "free"}` |
| Stripe not configured / Stripe error | 503 | `{"detail": "Billing isn't available right now. Please try again shortly."}` (details are only logged) |

---

## 8. Automated tests

```bash
cd backend
pytest                                   # all 270 tests (Postgres must be running; Redis and Stripe aren't needed)
pytest -k Isolation                      # just the tenant-isolation tests
pytest apps/core/tests/test_api.py::TestSprints -v
pytest --create-db                       # rebuild the test DB after a migration
```

The suite runs against a real PostgreSQL test database (`test_flowboard`), the same engine as
production, so constraints such as "one active sprint per project" are really exercised.

| File / class | What it proves |
|---|---|
| `test_tenancy.py::TestQueryIsolation` | `for_workspace()` only returns own rows; `.current()` fails closed without context |
| `test_tenancy.py::TestWriteIsolation` | foreign status/sprint/label/assignee are rejected at `save()`; a failed save doesn't burn an issue number |
| `test_tenancy.py::TestDomainRules` | per-project keys, ranking, `resolved_at`, one active sprint, default workflow, transitions, role ladder |
| `test_api.py::TestAuth` | register (+workspace), login, case-insensitive email, refresh rotation, logout blacklisting, change password |
| `test_api.py::TestTenantIsolation` | header required, foreign workspace → 404, lists scoped, same key resolves per tenant, foreign ids in payloads → 400, header switching can't reach foreign rows |
| `test_api.py::TestRolePermissions` | project/issue creation by role, delete rules, member-management rules, owner-only workspace delete (cascade works) |
| `test_api.py::TestProjectsAndIssues` | workspace list counts, project scaffolding, duplicate key, delete with issues, CRUD + every filter + pagination, transitions, move/reorder, rank rebalancing |
| `test_api.py::TestSprints` | create → start → second start refused → complete with carry-over → closed sprint is read-only; active sprint can't be deleted |
| `test_api.py::TestInvitations` | invite → preview → register with token → joined; email must match; members can't invite |
| `test_api.py::TestDashboardAndDocs` | dashboard aggregates; OpenAPI schema builds |
| `test_phase4.py` | workflow editor, comments and mentions, attachments, issue audit events |
| `automation/tests/test_api.py` | webhook CRUD and signing, notifications, async reports |
| `test_phase45_regressions.py` | move auditing, removed members, broker outages, scheduled jobs, webhook target safety and IP pinning |
| `test_reports_audit_email.py` | report calculations and CSV, audit coverage and filters, email content, opt-out and resend |
| `test_api_robustness.py` | malformed input across the API returns 4xx, never a server error |
| `billing/tests/test_billing.py::TestLimits` | project / member / file-size limits per plan, archived projects don't count, un-archiving is checked |
| `billing/tests/test_billing.py::TestApi` | billing state per role, owner-only Checkout / Portal / Sync, plan validation, Stripe errors → generic 503 (Stripe mocked) |
| `billing/tests/test_billing.py::TestWebhook` | signature check, duplicate events skipped, subscription events move the plan, cancellation → Free, payment-failed notification |
| `billing/tests/test_billing.py::TestWorkspaceDeletion` | the subscription is cancelled before a workspace is deleted |

Frontend checks:

```bash
cd frontend
pnpm typecheck        # strict TypeScript
pnpm build            # type-check + production bundle
```

End-to-end check of the whole Docker stack (stdlib only, no installs needed):

```bash
docker compose up -d --build --wait
python scripts/smoke_test.py                         # default http://localhost:8080
# … PASS lines …
# 26/26 checks passed
```

It logs in as the demo users and goes through nginx → gunicorn → Postgres/Redis/Celery: projects, issues,
boards, sprints, dashboard, tenant isolation, role blocks, comments, attachment upload + download, a report
built by the worker + CSV, notifications, webhooks, billing, an unsigned Stripe webhook and the OpenAPI
schema. GitHub Actions runs the same script on every push (see the README's CI/CD section). It adds a comment,
a report and audit entries to Acme; `seed_demo --reset` clears them.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `connection refused` on 8000 | `python manage.py runserver` isn't running |
| `OperationalError: connection … 5432` | start Docker Desktop, then `docker compose up -d db` |
| `400 {"workspace": …}` | add `-H "X-Workspace: acme"` |
| `404 Workspace not found.` with the right slug | the logged-in user isn't a member of it: log in as that workspace's user |
| `401 … token_not_valid` | access tokens last 30 min: log in again or call `/auth/refresh/` |
| `429` on login | wait a minute (20 logins/min limit) |
| report stays `pending`, webhook delivery never happens | start the Celery worker |
| Swagger UI is blank | it loads from a CDN: check your internet connection |
| ids in this doc don't match | ids change on every `seed_demo --reset`; look them up from the list endpoints |
| demo login fails after section 4.8 | you changed the password: `python manage.py seed_demo --reset` |
| `503` from `/billing/checkout/` | no `STRIPE_SECRET_KEY`, or prices missing: run `python manage.py stripe_setup` |
| `402 plan_limit_reached` | expected on that plan: upgrade via 4.16, or use Acme (Pro) / Initech (Enterprise) |
| `400` from `/billing/portal/` | the workspace has no billing account yet: start a checkout first |
| Docker: `connection refused` on 8080 | `docker compose ps`; wait for `backend` to be healthy, or check `docker compose logs backend` |
