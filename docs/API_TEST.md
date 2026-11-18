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
that prefix. (`http://localhost:8080/` itself is the web app's public home page, not the API.) Run management commands with `docker compose exec backend python manage.py …`, and see emails in
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

1. Open **http://127.0.0.1:8000/api/docs/** (development; production turns it off with `API_DOCS=off`). Swagger uses body mode: tokens come back in the JSON. It needs no login, but it loads its assets from a CDN, so you
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
| `Authorization: Bearer <access>` | every endpoint except register/login/refresh/logout, password reset, invitation preview, health, docs | `Bearer eyJhbGci…` |
| `X-Workspace: <slug>` | every **workspace-scoped** endpoint (see the table in section 5) | `X-Workspace: acme` |
| `Content-Type: application/json` | requests with a body | |
| `X-Auth-Mode: cookie` | optional; the browser app sends it on every request. Switches the auth endpoints to the httpOnly refresh cookie (see Tokens below) | `X-Auth-Mode: cookie` |

`?workspace=acme` as a query parameter works as a fallback for `X-Workspace`.

### Tokens

| Token | Lifetime | Notes |
|---|---|---|
| access | 30 minutes | send as Bearer |
| refresh | 7 days | **rotates**: every `/auth/refresh/` returns a new refresh token and blacklists the old one |

Changing or resetting your password revokes **every** refresh token you hold; change-password returns a new pair
for the current session. `POST /auth/logout-all/` revokes them all on demand. Expired tokens are deleted by a
nightly job; deactivated users can't refresh.

**Browser (cookie) mode.** Send `X-Auth-Mode: cookie` and the refresh token moves out of the JSON body into the
`fb_refresh` cookie (HttpOnly, SameSite=Strict, `Path=/api/auth/`). Refresh and logout then read it only from the
cookie; a body `refresh` is ignored and a missing cookie is a **401**. Without the header everything below works
as written (tokens in the body). The SPA always uses cookie mode.

```bash
curl -s -c jar.txt -X POST $API/auth/login/ -H "X-Auth-Mode: cookie" -H "Content-Type: application/json" \
  -d '{"email":"owner@acme.test","password":"Demo@1234"}'          # → 200 {"access": "…", "user": …}  (no "refresh")
curl -s -b jar.txt -c jar.txt -X POST $API/auth/refresh/ -H "X-Auth-Mode: cookie"   # → 200 {"access": "…"}, cookie rotated
curl -s -b jar.txt -c jar.txt -X POST $API/auth/logout/ -H "X-Auth-Mode: cookie" -o /dev/null -w "%{http_code}\n"  # 204, cookie cleared
curl -s -X POST $API/auth/refresh/ -H "X-Auth-Mode: cookie" -o /dev/null -w "%{http_code}\n"   # 401: no cookie
```

### Lookups

- Projects are addressed by **key**: `/api/projects/WEB/` (case-insensitive, so `/projects/web/` works too)
- Issues are addressed by **key**: `/api/issues/WEB-12/` (case-insensitive, so `web-12` works too)
- Everything else uses its numeric **id**: `/api/sprints/60/`, `/api/members/12/`

### Pagination

Add `?page=N` (and optionally `page_size`) to get a paginated envelope:

```json
{ "count": 16, "next": "http://127.0.0.1:8000/api/issues/?page=2&page_size=2&project=WEB&sprint=active",
  "previous": null, "results": [ … ] }
```

Without `?page=`, most lists return a **plain JSON array**, with these bounds:

| List | Without `?page=` | With `?page=` |
|---|---|---|
| `GET /issues/` | needs `project` or `search`, otherwise **400**; at most 1,000 rows | any filters, `page_size` ≤ 500 |
| `GET /audit-log/` | **always paginated** (50 per page) | `page_size` ≤ 200 |
| comments, issue activity | the latest 200 | 50 per page, ≤ 200 |
| webhook deliveries, notifications | the latest 100 | 50 per page, ≤ 200 |
| reports | the latest 50 | 50 per page, ≤ 200 |

When a capped list had more matching rows, the response carries `X-Truncated: true`. The order is always
stable (the requested ordering plus the id as a tiebreak), so the cap and the pages are predictable.

### Status codes

| Code | Meaning in FlowBoard |
|---|---|
| 200 / 201 / 204 | OK / created / deleted (also: logged out) |
| 202 | accepted for background processing (reports, webhook test and redelivery, invitation resend) |
| 400 | validation error, missing `X-Workspace`, cross-tenant id, disallowed transition, archived project, missing confirmation |
| 401 | missing/expired/blacklisted token, wrong credentials |
| 402 | plan limit reached |
| 403 | authenticated member, but the role is too low (e.g. viewer writing, admin managing another admin) |
| 404 | not found **or not yours**: other tenants' workspaces and rows are indistinguishable from missing ones |
| 405 | `PUT` on projects, issues and webhooks: use `PATCH` |
| 409 | database constraint conflict that wasn't turned into a field error (rare race) |
| 429 | rate limit (table below), resend cooldown, or a webhook's own 429 |
| 503 | Stripe unavailable or not configured (details are only logged) |

### Rate limits

Counters live in the shared Redis cache, so they hold across every API process.

| What | Limit | Counted per |
|---|---|---|
| `POST /auth/login/` | 5/min, plus 10 failures per 15 min per email | IP, and email |
| `POST /auth/register/` | 10/hour | IP |
| `POST /auth/refresh/` | 30/min per account (valid token) · 30/min per IP (invalid token) · 600/min per IP overall | account, IP |
| `POST /auth/change-password/` | 5/hour | user |
| `POST /auth/password-reset/` · `/confirm/` | 5/hour · 10/hour | IP |
| `POST /workspaces/` | 10/hour (and at most 10 owned workspaces) | user |
| invitation preview and accept | 30/min | IP |
| `POST /invitations/{id}/resend/` | one per 60 s | invitation |
| `POST /webhooks/{id}/test/` | 5/min per endpoint and 10/min per user | endpoint, user |
| `POST /webhooks/{id}/deliveries/{did}/redeliver/` | 5/min | user |
| `POST /reports/` | 10/hour | user |
| `POST /billing/checkout/` and `/portal/` | 10/min (shared) | user |
| `POST /billing/sync/` | 6/min | workspace |

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
    "job_title": "CTO", "email_notifications": true, "date_joined": "2026-10-31T19:00:18.538341Z"
  }
}
```

Email is case-insensitive and trimmed (`OWNER@acme.test` works). Wrong password →
`401 {"detail": "No active account found with the given credentials"}`. After 10 failures for one email within
15 minutes (from any number of IPs) that email gets `429` until the window ends; a successful login resets the count.

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

Create, update and archive (admin or owner); delete (owner only):

```bash
# create: also scaffolds a 4-status workflow and a board
curl -s -X POST $API/projects/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"name":"Data Platform","key":"dp","board_type":"kanban","color":"#14b8a6"}'
# → 201, key normalised to "DP"; "statuses" has 4 entries and "board.board_type" is "kanban"
# "color" must be #RRGGBB; a key already used (in any case) → 400 on "key"

curl -s -X PATCH $API/projects/DP/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"description":"Warehouse + ETL","is_archived":true}'
# archived projects are read-only: any other write returns 400 {"project": ["Restore the project first."]}
# restore with {"is_archived": false} (checked against the plan's project limit)

# delete: owner only, and the key must be typed back (any case)
curl -s -X DELETE $API/projects/DP/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"confirm":"DP"}' -o /dev/null -w "%{http_code}\n"                                      # 204
# missing or wrong "confirm" → 400; an admin → 403. Attachment files are removed after the delete commits.
```

`PUT /projects/{key}/` returns **405**: update with `PATCH`. (The workflow's `PUT` below is a real full replace.)

Set a WIP limit on a board column (admin): `{"<status id>": max}`. Keys must be this project's status ids, values
whole numbers ≥ 1 (not `true`, `2.5` or `"3"`), and `null` removes a limit. Limits for statuses removed from the
workflow are dropped automatically.

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
curl -s "$API/issues/" -H "$AUTH" -H "$WS"         # → 400: unpaged lists need project or search (or use ?page=)
```

Search runs on key, title and description and is backed by trigram indexes, so it stays fast on big workspaces.

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
| `parent` | issue id or `null` | same project; see the hierarchy below; no cycles |
| `assignee` | user id or `null` | must be a member of this workspace |
| `story_points` | JSON integer 0–100, or `null` | `true`, `2.5` and `"3"` are rejected |
| `due_date` | `YYYY-MM-DD` or `null` | within 10 years either side of today |
| `labels` | `[label ids]` | same workspace only |

Parent hierarchy, checked under the project lock whenever the parent or the type changes:

| Parent | Allowed children |
|---|---|
| `epic` | `story`, `task`, `bug` |
| `story`, `task`, `bug` | `subtask` |
| `subtask` | none |

An issue with children can't change to a type that can't hold them (e.g. a story with sub-tasks can't become a
`subtask`). Issues created under the older rules stay editable as long as their parent and type don't change.

**Update** (partial; `PUT` returns 405):

```bash
curl -s -X PATCH $API/issues/$KEY/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"priority":5,"assignee":47,"labels":[]}'
```

Issue create, update and move take a shared lock on the project, so they can't race a workflow replacement: if the
chosen status was deleted meanwhile you get `400 {"status": [...]}`, never a 500.

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

**Delete** (the reporter or an admin; not in an archived project):

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
# create (name optional or blank → "WEB Sprint <highest number + 1>", so numbers never go backwards)
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

Rules:
- only `planned` sprints start, and only the `active` one completes. Both lock the project, so a double click
  gets a `400` instead of a second start or a second completion event
- closed sprints are read-only, and renaming a sprint to a blank name is a `400`
- `goal` is at most 10,000 characters (on create, PATCH and start); an active sprint's dates can't be cleared
- a PATCH is checked against the sprint **as it is when it gets the lock**: if the sprint was completed meanwhile,
  the PATCH is a `400` (read-only) instead of silently reopening it
- only **planned** sprints can be deleted (admin). Active and closed ones are `400`: closed sprints are velocity
  history. Deleting a planned sprint sends its issues back to the backlog
- in an archived project every sprint write is `400 {"project": ["Restore the project first."]}`

### 4.6 Labels, members, invitations

```bash
curl -s $API/labels/ -H "$AUTH" -H "$WS"
curl -s -X POST $API/labels/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"name":"Customer-Facing","color":"#ec4899"}'
# name stored in one canonical form (trimmed, Unicode NFC + casefold) and unique per workspace: "Bug"/"bug",
# "ΣΑΣ"/"σας" and composed/decomposed accents all collide → 400 on "name". At most 40 characters AFTER folding
# ("İ" folds to 2 characters). color must be #RRGGBB. Limits: 500 labels per workspace, 20 labels per issue (400).

curl -s $API/members/ -H "$AUTH" -H "$WS"
curl -s -X PATCH $API/members/<membership id>/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"role":"member"}'
```

Who may change or remove whom:

| Action | Owner | Admin |
|---|:-:|:-:|
| grant the admin role, change an admin's role, remove an admin | ✅ | ❌ 403 |
| change members and viewers between `member` and `viewer`, remove them | ✅ | ✅ |
| change anyone to `owner` | ❌ 400: use transfer-ownership | ❌ 400 |
| change your own role | ❌ 403 | ❌ 403 |

Anyone except the owner may leave with `DELETE /members/<own id>/`. Removing or leaving unassigns that person's
issues in the workspace (reporter, comments and history are kept) and records the count in the audit log.

**Ownership transfer** (owner only, to someone who has already joined):

```bash
curl -s -X POST $API/workspace/transfer-ownership/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"member_id": <membership id>}'
# → 200 the workspace; the new owner gets "owner", you become "admin". The Stripe billing email follows.
```

**Deleting the workspace** (owner only) needs the slug and your password in the body:

```bash
curl -s -X DELETE $API/workspace/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"confirm":"acme","password":"Demo@1234"}'          # 202; wrong or missing either → 400
# → 202 {"detail": "Workspace deletion started."}
```

Deletion is asynchronous. The workspace disappears at once: every request with its `X-Workspace` now returns 404,
it leaves `GET /workspaces/`, its invitation links stop working, and a second `DELETE` is a 404. A background job
cancels the Stripe subscription (retrying if Stripe is down; no data is deleted before Stripe confirms) and then
removes the data in batches. A write that was already in flight when deletion started is rejected with 404.

Invitation flow (admin creates it, then the invitee accepts). Only the owner can invite with `"role":"admin"`, and an
admin invitation stops working if its sender is no longer the owner when it's accepted:

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
# a missing, null, blank or non-string token → 400 on "token"
```

Preview and accept are limited to 30 requests per minute per IP. Preview returns only those display fields, never the
token. `POST /invitations/{id}/resend/` resends at most once a minute (`429` otherwise) and extends the expiry by 7
days. Only one open invitation per email can exist (enforced in the database); inviting again after it expired
replaces the old one. Expired invitations disappear from the list and are purged 30 days after they expire.

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
  -d "{\"refresh\":\"$(echo "$NEW_TOKENS" | json "['refresh']")\"}" -o /dev/null -w "%{http_code}\n"   # 204
# logging out the same token again → 204; missing or malformed "refresh" → 400

curl -s -X POST $API/auth/logout-all/ -H "$AUTH" -o /dev/null -w "%{http_code}\n"    # 204: every session revoked

curl -s -X POST $API/auth/change-password/ -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"current_password":"Demo@1234","new_password":"N3w-pass-123"}'
# → 200 {"refresh": "…", "access": "…"}: every older refresh token is revoked; keep using this new pair
```

**Forgotten password.** The request always answers `204`, whether or not the email has an account, so it can't be
used to check emails. With the worker running, the email prints in its terminal; the link looks like
`…/reset-password/<uid>/<token>`, works once and expires after an hour.

```bash
curl -s -X POST $API/auth/password-reset/ -H "Content-Type: application/json" \
  -d '{"email":"owner@acme.test"}' -o /dev/null -w "%{http_code}\n"                      # 204

curl -s -X POST $API/auth/password-reset/confirm/ -H "Content-Type: application/json" \
  -d '{"uid":"<uid>","token":"<token>","new_password":"N3w-pass-123"}'                     # 204, all sessions revoked
# bad or used link → 400 on "token"; weak password → 400 on "new_password"
```

> Re-run `python manage.py seed_demo --reset` afterwards to restore the demo passwords and data.

### 4.9 Workflows

```bash
curl -s $API/projects/WEB/workflow/ -H "$AUTH" -H "$WS"       # any role
# {"name": "...", "enforce_transitions": false, "statuses": [...], "transitions": [{"from": 0, "to": 1}]}
```

`PUT` (admin) replaces the workflow. List order sets the status order, and transitions use **indexes into that
list**. A status with an `id` is kept, one without is created, and one left out is deleted. A status in use can't
be removed or change category. At least one `todo` and one `done` status are required, names are unique ignoring
case, and names can't start with `__workflow_tmp_` (reserved for the save step). With `"enforce_transitions": true`
at least one transition is required and every status must take part in one, in or out (separate groups such as
A→B and C→D are fine) → otherwise 400 on `transitions`, naming the unconnected statuses. The replacement locks the
project and validates under that lock, so it can't race an issue moving into a status it deletes.

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

Comments list oldest first (a conversation); activity lists newest first. Only a comment's **author** can edit it
(`403` for anyone else, admins included); the author or an admin can delete it. An edit notifies only people it newly
@mentions. Attachment deletes need the uploader or an admin.

Allowed files: CSV, GIF, JPEG, Markdown, PDF, PNG, TXT, WebP, ZIP, within the plan's size and a hard 100 MB cap.
The **contents** decide, not the name or `Content-Type`: images, PDF and ZIP must start with their real signature,
and text files must be valid UTF-8 without NUL bytes. SVG, HTML and every other type are rejected, and the stored
content type is the verified one, one canonical type per extension (`text/csv` for `.csv`, `application/zip` for
`.zip`, …). `GET /issues/{key}/attachments/` returns the newest 200 (`X-Truncated: true` when there are more) or
pages of 50 with `?page=`. In an archived project, comment and attachment writes and issue deletes return
`400 {"project": ["Restore the project first."]}`; reads still work.

### 4.11 Webhooks (admin)

```bash
CREATED=$(curl -s -X POST $API/webhooks/ -H "$AUTH" -H "$WS" -H "Content-Type: application/json" \
  -d '{"name":"Receiver","url":"https://example.com/hook","events":["issue.created","issue.moved"]}')
HOOK=$(echo "$CREATED" | json "['id']")
echo "$CREATED" | json "['secret']"        # the full signing secret: shown ONLY here and by rotate-secret
curl -s $API/webhooks/$HOOK/ -H "$AUTH" -H "$WS"                        # "secret_hint": "••••a1b2", never the secret
curl -s -X POST $API/webhooks/$HOOK/test/ -H "$AUTH" -H "$WS"           # 202, needs the worker
curl -s $API/webhooks/$HOOK/deliveries/ -H "$AUTH" -H "$WS"             # newest 100, or ?page=
curl -s -X POST $API/webhooks/$HOOK/deliveries/<delivery id>/redeliver/ -H "$AUTH" -H "$WS"   # failed ones only, 202
curl -s -X POST $API/webhooks/$HOOK/rotate-secret/ -H "$AUTH" -H "$WS"  # {"secret": "<new full secret>"}
```

Events: `issue.created|updated|moved|commented|attached|detached|deleted`, or `*`. A workspace can have at most 10
webhooks (`MAX_WEBHOOKS_PER_WORKSPACE`). `PUT` returns 405; edit with `PATCH`.

**Verifying a delivery.** Every attempt carries:

| Header | Value |
|---|---|
| `X-FlowBoard-Event` | e.g. `issue.created` |
| `X-FlowBoard-Delivery` | event id: the same on every retry and redelivery, so dedupe on it |
| `X-FlowBoard-Timestamp` | Unix seconds, fresh on each attempt |
| `X-FlowBoard-Signature` | `sha256=` + hex HMAC-SHA256 of `"<timestamp>.<exact raw body>"` with the secret |

Compare in constant time and reject timestamps more than 5 minutes off; `apps/automation/signing.py` has
`verify()` as a reference. The payload's `actor` is `{"id", "display_name"}`, with no email.

**Delivery rules.** Network errors, 5xx and 429 (honouring `Retry-After`) retry up to 5 times with backoff; other
4xx and redirects fail at once. After 20 failed deliveries in a row the webhook is disabled (`is_active: false`,
with `disabled_reason`); `PATCH {"is_active": true}` re-enables it and resets the count. Each attempt is capped at
20 seconds in total. Targets must be HTTPS with public addresses outside `DEBUG`; every resolved IP is checked, the
connection goes to the checked IP, and redirects are never followed. Disabled webhooks can't be tested or
redelivered.

### 4.12 Notifications

```bash
curl -s $API/notifications/ -H "$AUTH" -H "$WS"               # {"unread_count": 1, "results": [newest 100]}
curl -s "$API/notifications/?page=2" -H "$AUTH" -H "$WS"      # paged, still with unread_count over all unread
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

Asking for a report identical to one that's still `pending` returns that report with **200** instead of queuing
another (a pending build older than 15 minutes counts as lost and is replaced). Limit: 10 requests per hour per user.
A failed report shows a clear reason when it's an expected one (e.g. "The sprint for this report was deleted.") and
otherwise only "Report generation failed. Try again."; the details stay in the server log.

### 4.14 Audit log (admin)

```bash
curl -s "$API/audit-log/?entity_type=sprint&project=WEB&page=1&page_size=20" -H "$AUTH" -H "$WS"
```

Filters: `entity_type`, `action`, `actor` (user id), `project` (key), `date_from`, `date_to`, `search`. The endpoint
is read-only and **always paginated** (50 per page by default, `page_size` up to 200).

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
 "over_limit": {"projects": null, "members": {"used": 8, "limit": 5}},
 "can_manage": true, "stripe_configured": true, "has_billing_account": false, "subscription": null}
```

`null` means unlimited (in `plans`) or within the limit (in `over_limit`). Globex is a demo workspace on Free that
already has 8 members, so it shows the "limits only block adding more" rule: it keeps all 8 and can still view, edit
and delete everything, but a new invitation returns 402. `over_limit` counts members plus pending invitations, the
same way the limit is checked.

```bash
# owner: start an upgrade → open the returned URL, pay with 4242 4242 4242 4242
curl -s -X POST $API/billing/checkout/ -H "$GLOBEX" -H "$GWS" -H "Content-Type: application/json" -d '{"plan":"pro"}'
# → 200 {"url": "https://checkout.stripe.com/c/pay/cs_test_…"}
# asking again for the same plan while that session is still open (per Stripe) returns the SAME url
# {"plan":"free"}, null, a number or a Stripe price id → 400 on "plan" (the server picks the price)
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

| Webhook outcome | Response |
|---|---|
| invalid signature | 400 |
| duplicate event, unknown customer, ignored type | 200 |
| processed | 200 |
| Stripe unreachable | 503: Stripe retries |
| any other failure | 500 (logged with event id and type): Stripe retries; nothing is recorded, so the retry runs it again |

Every subscription event re-reads **all** of the customer's subscriptions from Stripe rather than trusting the
event body, so out-of-order events can't apply stale state. If two live subscriptions exist (two checkouts both
completed), the oldest is kept and the others are **cancelled, not refunded**; the audit log flags each one for a
manual refund review. The Stripe calls happen before the database transaction, and a snapshot whose fetch started
before the one already applied is discarded.

---

## 5. Endpoint reference

**WS?** = needs `X-Workspace`. **Min role** applies inside that workspace.

| Method & path | WS? | Min role | Purpose |
|---|:-:|---|---|
| `GET /health/` | | public | liveness + DB check |
| `POST /auth/register/` | | public | sign up (+ `workspace_name` or `invite_token`) · throttled. Cookie mode: refresh token set as the `fb_refresh` cookie, not in the body |
| `POST /auth/login/` | | public | JWT pair + user · throttled. Cookie mode: `{access, user}` + `fb_refresh` cookie |
| `POST /auth/refresh/` | | public | rotate tokens · throttled. Body mode: `{refresh}` → `{access, refresh}`. Cookie mode: reads only the cookie → `{access}` + rotated cookie; no or invalid cookie → 401 and the cookie is cleared |
| `POST /auth/logout/` | | public | revoke one refresh token → 204 (body mode: 400 if missing/malformed). Cookie mode: revokes the cookie's token if valid, always clears the cookie, 204 |
| `POST /auth/logout-all/` | | logged in | revoke every refresh token → 204 (cookie mode also clears the cookie) |
| `POST /auth/password-reset/` | | public | email a reset link → always 204 · throttled |
| `POST /auth/password-reset/confirm/` | | public | `uid`, `token`, `new_password` → 204 · throttled |
| `GET/PATCH /auth/me/` | | logged in | profile (`first_name`, `last_name`, `job_title`, `avatar_color`, `email_notifications`) |
| `POST /auth/change-password/` | | logged in | → 200 new token pair; other sessions revoked · throttled. Cookie mode: `{access}` + new cookie |
| `GET/POST /workspaces/` | | logged in | my workspaces (with my role) / create one (I become owner; ≤ 10 owned) |
| `GET /workspace/` | ✅ | viewer | current workspace |
| `PATCH /workspace/` | ✅ | admin | rename |
| `DELETE /workspace/` | ✅ | owner | `{"confirm": "<slug>", "password": "…"}` → **202**; hidden at once, data removed in the background |
| `POST /workspace/transfer-ownership/` | ✅ | owner | `{"member_id": …}`: you become admin |
| `GET /members/` | ✅ | viewer | list (`?search=`) |
| `PATCH /members/{id}/` | ✅ | admin (owner for admins) | change role (see the matrix in 4.6) |
| `DELETE /members/{id}/` | ✅ | admin (owner for admins), or yourself | remove / leave; their issues are unassigned |
| `GET/POST /invitations/` | ✅ | admin (owner to invite admins) | pending invitations (`?page=`) / invite |
| `DELETE /invitations/{id}/` | ✅ | admin | revoke |
| `GET /invitations/preview/{token}/` | | public | what an invite link is for · throttled |
| `POST /invitations/accept/` | | logged in | join (email must match) · throttled |
| `GET /projects/` · `GET /projects/{key}/` | ✅ | viewer | `?search=`, `?is_archived=`; key in any case |
| `POST/PATCH /projects/…` | ✅ | admin | create (scaffolds workflow + board), edit, archive / restore |
| `DELETE /projects/{key}/` | ✅ | owner | `{"confirm": "<KEY>"}` |
| `GET /boards/` · `GET /boards/{id}/` | ✅ | viewer | `?project=<id>` |
| `PATCH /boards/{id}/` | ✅ | admin | `wip_limits` |
| `GET /sprints/` · `GET /sprints/{id}/` | ✅ | viewer | `?project=<id or key>&state=planned,active,closed` |
| `POST/PATCH /sprints/…` | ✅ | member | create / edit (not closed) |
| `POST /sprints/{id}/start/` | ✅ | member | `start_date`, `end_date`, `goal` (all optional) |
| `POST /sprints/{id}/complete/` | ✅ | member | `move_open_issues_to`: sprint id or null |
| `DELETE /sprints/{id}/` | ✅ | admin | planned sprints only |
| `GET /issues/` · `GET /issues/{key}/` | ✅ | viewer | filters below; unpaged needs `project` or `search` |
| `POST/PATCH /issues/…` | ✅ | member | create / partial update (no `PUT`) |
| `POST /issues/{key}/move/` | ✅ | member | drag-and-drop |
| `DELETE /issues/{key}/` | ✅ | member (own) / admin | |
| `GET /labels/` · `POST/PATCH /labels/…` | ✅ | viewer / member | |
| `DELETE /labels/{id}/` | ✅ | admin | |
| `GET /dashboard/` | ✅ | viewer | aggregated stats |
| `GET /projects/{key}/workflow/` | ✅ | viewer | statuses + transitions |
| `PUT /projects/{key}/workflow/` | ✅ | admin | replace the workflow |
| `GET/POST /issues/{key}/comments/` | ✅ | viewer / member | list (oldest first, `?page=`) / add |
| `PATCH /issues/{key}/comments/{id}/` | ✅ | author only | edit |
| `DELETE /issues/{key}/comments/{id}/` | ✅ | author or admin | delete |
| `GET/POST /issues/{key}/attachments/` | ✅ | viewer / member | list / upload (multipart) |
| `GET /attachments/{id}/download/` | ✅ | viewer | download |
| `DELETE /attachments/{id}/` | ✅ | uploader or admin | delete |
| `GET /issues/{key}/activity/` | ✅ | viewer | issue history (newest first, `?page=`) |
| `GET/POST /webhooks/` · `GET/PATCH/DELETE /webhooks/{id}/` | ✅ | admin | webhooks (≤ 10; secret only in the create response) |
| `POST /webhooks/{id}/test/` · `POST /webhooks/{id}/rotate-secret/` | ✅ | admin | test delivery (throttled) / new secret |
| `GET /webhooks/{id}/deliveries/` · `POST /webhooks/{id}/deliveries/{did}/redeliver/` | ✅ | admin | history (`?page=`) / redeliver a failed one |
| `GET /notifications/` · `POST /notifications/{id}/read/` · `POST /notifications/read-all/` | ✅ | viewer | your own notifications (`?page=`) |
| `GET /reports/` · `GET /reports/{id}/` · `GET /reports/{id}/download/` | ✅ | viewer | read (`?page=`) / CSV |
| `POST /reports/` | ✅ | member | generate (identical pending → 200) · throttled |
| `GET /audit-log/` | ✅ | admin | workspace history, always paginated |
| `POST /invitations/{id}/resend/` | ✅ | admin | email again (once a minute; extends expiry) |
| `GET /billing/` | ✅ | viewer | plan, plan catalog, usage, `over_limit`, subscription status |
| `POST /billing/checkout/` | ✅ | owner | `{"plan": "pro" \| "enterprise"}` → Stripe Checkout URL (reused while open) · throttled |
| `POST /billing/portal/` | ✅ | owner | Stripe Customer Portal URL · throttled |
| `POST /billing/sync/` | ✅ | owner | re-read the subscription from Stripe · throttled per workspace |
| `POST /billing/webhook/` | | Stripe signature | Stripe events (not in Swagger) |
| `GET /schema/` · `GET /docs/` | | `API_DOCS` | OpenAPI 3 + Swagger UI: public in development, `staff` or 404 (`off`, the production default) otherwise |

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

Without `page`, `project` or `search` is required, and at most 1,000 rows come back (`X-Truncated: true` if more
matched).

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
| 10 | Promote to owner | admin → `PATCH /members/{id}/ {"role":"owner"}` | **400** `Ownership changes go through the transfer-ownership endpoint.` |
| 11 | Reuse a rotated refresh token | see 4.8 | **401** `Token is blacklisted` |
| 12 | Accept someone else's invite | logged in as a different email → `POST /invitations/accept/` | **403** |
| 13 | Disallowed workflow transition | with `enforce_transitions` on, move To Do → Done without a rule | **400** `Transition 'To Do' → 'Done' is not allowed.` |
| 14 | Brute-force login | 6 logins in a minute from one IP, or 10 failures for one email from many IPs | **429** |
| 15 | Another tenant's attachment or report | their id on `/attachments/{id}/download/` or `/reports/{id}/download/` | **404** |
| 16 | Non-admin reads the audit log or webhooks | member token | **403** |
| 17 | Webhook to an internal address | `https://169.254.169.254/` with `DEBUG=False` | **400** |
| 18 | Write to an archived project | issue, comment, attachment, sprint, board or workflow write | **400** `{"project": ["Restore the project first."]}` |
| 19 | Upload a blocked or disguised file | `run.html`, or HTML renamed to `.png` | **400** |
| 24 | Admin manages another admin | admin → `PATCH`/`DELETE /members/{other admin}/`, or invite with `"role":"admin"` | **403** / **400** |
| 25 | Admin edits someone else's comment | admin → `PATCH /issues/{key}/comments/{id}/` | **403** (deleting it is allowed) |
| 26 | Old session after a password change | refresh with a token issued before `change-password` or a reset | **401** |
| 27 | Another tenant's webhook or delivery | their id on any `/webhooks/{id}/…` route, including redeliver | **404** |
| 28 | Read a webhook secret | `GET /webhooks/{id}/` | only `secret_hint` (`••••a1b2`) |
| 29 | Delete without confirming | `DELETE /projects/{key}/` or `/workspace/` without `confirm` (and `password`) | **400** |
| 30 | Refresh token in the body in cookie mode | `X-Auth-Mode: cookie` + `{"refresh": "…"}`, no cookie | **401** (the body is never used in cookie mode) |
| 31 | Admin from an unlisted IP | `GET /admin/` through nginx from an IP not in `ADMIN_ALLOWLIST` | **404** |
| 32 | Swagger in production | `GET /api/docs/` with `API_DOCS=off` | **404** |
| 33 | Secret in a logged URL | open `/reset-password/<uid>/<token>` or `/api/invitations/preview/<token>/` | the nginx and Django log lines show `[REDACTED]` instead of the token |
| 34 | Escape a per-IP limit with a spoofed header | send a different `X-Forwarded-For` with each login (through nginx) | still **429** after 5: only the last entry, added by nginx, counts |
| 35 | Many users behind one office IP | several accounts refresh from the same IP | each account has its own 30/min; only invalid tokens share the per-IP limit |
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
| child type a parent can't hold | 400 | `{"parent": ["An epic can only contain: bug, story, task."]}` |
| parent loop | 400 | `{"parent": ["This would create a cycle of parent issues."]}` |
| second active sprint | 400 | `["This project already has an active sprint. Complete it first."]` |
| delete active sprint | 400 | `["Complete the sprint before deleting it."]` |
| delete closed sprint | 400 | `["Completed sprints are kept for velocity and reports and can't be deleted."]` |
| archived project | 400 | `{"project": ["Restore the project first."]}` |
| unpaged issue list without a filter | 400 | `{"detail": "Filter by project or search, or request a page with ?page=."}` |
| remove the owner | 403 | `{"detail": "The workspace owner can't be removed. Transfer ownership first."}` |
| admin changes an admin | 403 | `{"detail": "Only the owner can grant or change the admin role."}` |
| `PUT` on a project, issue or webhook | 405 | `{"detail": "Use PATCH to update a project."}` (or issue) |
| resend too soon | 429 | `{"detail": "This invitation was just sent. Try again in a minute."}` |
| plan limit reached | 402 | `{"detail": "Your plan allows 3 active projects. …", "code": "plan_limit_reached", "limit": "projects", "current_plan": "free"}` |
| Stripe not configured / Stripe error | 503 | `{"detail": "Billing isn't available right now. Please try again shortly."}` (details are only logged) |

---

## 8. Automated tests

```bash
cd backend
pytest                                   # all 995 tests (Postgres and Redis must be running; Stripe isn't needed)
pytest -k Isolation                      # just the tenant-isolation tests
pytest apps/core/tests/test_api.py::TestSprints -v
pytest --create-db                       # rebuild the test DB after a migration
```

The suite runs against a real PostgreSQL test database (`test_flowboard`), the same engine as
production, so constraints such as "one active sprint per project" are really exercised. Redis is needed because
rate limits use the shared cache (database 1, separate from the Celery broker); `conftest.py` clears it before every
test. Celery tasks run eagerly in tests, so no worker is needed.

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
| `billing/tests/test_billing.py::TestWorkspaceDeletion` | the background purge cancels the subscription before deleting any data; a Stripe outage keeps the (hidden) workspace and its data |
| `test_api.py::TestAuth` (extended) | per-email lockout, logout 204/400, logout-all, password reset flow, register trimming and race, `is_staff` hidden |
| `tenants/tests/test_group2_hardening.py` | owner/admin role matrix, ownership transfer, delete confirmation, slug race, owned-workspace cap, one open invite per email, unassign on removal, invite purge, resend cooldown, public endpoint throttles and shape |
| `projects/tests/test_group3_hardening.py` | owner-only project delete with confirmation, files removed only after commit, archived read-only, key race and DB case rule, sprint lock order, planned-only sprint delete, sprint naming, workflow lock and query count, WIP limit rules, color, PUT 405 |
| `issues/tests/test_group4_hardening.py` | author-only comment edit, archived guard on comments/files/deletes, parent hierarchy and cycles under the lock, file signature checks, upload cleanup on failure, list caps and `X-Truncated`, audit always paged, trigram index used, label rules, story points and due-date bounds |
| `automation/tests/test_group5_hardening.py` | one-time webhook secret, timestamped signatures, SSRF and redirects, test/redelivery throttles, endpoint cap under concurrency, retry policy and `Retry-After`, auto-disable once, delivery claims and lease recovery, 20 s attempt deadline, redelivery rules, retention purge, grouped digest, report dedupe under concurrency, stale report runs, pagination, no actor email, tenant isolation |
| `*/tests/test_<table>_table.py` (21 files, the schema review) | one file per table, e.g. `tenants/tests/test_workspace_table.py`, `projects/tests/test_sprint_table.py`, `automation/tests/test_delivery_table.py`, `billing/tests/test_stripeevent_table.py`: lost-update races (a stale PATCH against start/complete, auto-disable, pruning, issue numbering), every CHECK / trigger / composite FK hit through raw SQL and bulk writes, async workspace deletion (partial purge + retry, Stripe retry, concurrent writes, lock orderings), index plans, and each migration's "report and stop" path |
| `core/tests/test_security_hardening.py` | production settings: API docs gate, CORS, SSL redirect exemption, HSTS opt-ins, the shared admin/API login lockout |
| `accounts/tests/test_cookie_auth.py` | cookie mode: cookie attributes, no refresh in bodies, cookie-only refresh/logout, matching clear on logout/401, logout-all, body mode unchanged |
| `automation/tests/test_token_cleanup.py` | nightly expired-token cleanup: only expired rows, revoked live tokens stay revoked, batches, resumes after a failure, retries |
| `accounts/tests/test_refresh_rate_limits.py` | layered refresh limits: users sharing an IP refresh independently, one account over its limit is throttled, invalid/forged/revoked tokens use the IP bucket and never the victim's, the IP ceiling, retry after the window, counters visible from another Redis connection, body mode unchanged, 429 keeps the cookie, spoofed `X-Forwarded-For` can't escape the refresh or login limits |
| `core/tests/test_log_redaction.py` | reset, invite and invite-preview tokens (in paths, encoded query strings and secret query parameters) never reach the logs; ordinary paths, status and timing stay |
| `billing/tests/test_group6_hardening.py` | concurrent checkout opens one session, session reuse rules, customer idempotency, duplicate subscriptions cancelled and audited, lock order, stale and overlapping snapshots, owner-email task, throttles, webhook transaction boundary and 500 handling, StripeEvent purge, `over_limit`, cancel-then-failed-delete retry |

Frontend checks:

```bash
cd frontend
pnpm test             # Vitest unit + component tests (68 tests, ~15 s, no backend needed)
pnpm test:watch       # re-run tests on file change
pnpm typecheck        # strict TypeScript
pnpm build            # type-check + production bundle
```

The frontend tests use **Vitest** + **React Testing Library** in a `jsdom` environment (config in the `test`
block of `vite.config.ts`, setup in `src/test/setup.ts`). The API is mocked, so they run without Django.

| File | What it proves |
|---|---|
| `src/lib/utils.test.ts` | Kanban rank math (`rankBetween`) for empty column, top, bottom and between cards; API error → message mapping (network, 5xx, DRF `detail`, field errors, `non_field_errors`); 402 plan-limit detection; field-error map; pluralize, percent, overdue dates |
| `src/components/ui/Button.test.tsx` | default `type="button"`, click handler, disabled while loading, accessible label on `IconButton` |
| `src/store/auth.test.ts` | the auth store stays in memory (nothing in localStorage), starts as `restoring`, removes the legacy persisted tokens |
| `src/lib/session.test.ts` | cookie-mode refresh, single-flight and Web Locks serialisation, session restore (401 → login, network error → retry), no auto-refresh without Web Locks, logout only after a 204, no tokens in cross-tab messages; a 429 keeps the session and `Retry-After` is honoured |
| `src/App.test.tsx` | the session screen per restore outcome: 429 → rate-limit message with countdown and automatic retry, network error → connection message, 401 → login |
| `src/components/settings/AutomationSections.test.tsx` | webhook deliveries refresh while in flight and stop when terminal; Redeliver success and refusal; no button on delivered/in-flight rows; disabled endpoint; non-admins see nothing |
| `src/pages/project/BoardPage.test.tsx` | board and backlog stop rendering when queries have no data (regression for a render loop that froze navigation) |
| `src/pages/auth/LoginPage.test.tsx` | `safeNext` open-redirect guard (external, protocol-relative and auth-page targets), submit → redirect to `next`, error message on failed login, signed-in users skip the form |

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
| `401 no_refresh_cookie` on refresh | you sent `X-Auth-Mode: cookie` without the cookie; drop the header to use a body token |
| `429` on refresh with `Retry-After` | that account refreshed more than 30 times in a minute, or the IP sent 30 invalid tokens; wait the given seconds. The session isn't ended |
| `429` on login | wait a minute (5 logins/min per IP), or 15 minutes after 10 failed attempts for that email |
| `429` everywhere in tests or after a restart | counters live in Redis: `python manage.py shell -c "from django.core.cache import cache; cache.clear()"` |
| `ConnectionError` mentioning Redis or port 6380 | start Redis (`docker compose up -d redis`): rate limits need the shared cache |
| `400 Filter by project or search…` on `/issues/` | add `?project=WEB`, `?search=…`, or `?page=1` |
| webhook receiver rejects the signature | sign `"<X-FlowBoard-Timestamp>.<raw body>"`, not the body alone (see 4.11) |
| report stays `pending`, webhook delivery never happens | start the Celery worker |
| Swagger UI is blank | it loads from a CDN: check your internet connection |
| ids in this doc don't match | ids change on every `seed_demo --reset`; look them up from the list endpoints |
| demo login fails after section 4.8 | you changed the password: `python manage.py seed_demo --reset` |
| `503` from `/billing/checkout/` | no `STRIPE_SECRET_KEY`, or prices missing: run `python manage.py stripe_setup` |
| `402 plan_limit_reached` | expected on that plan: upgrade via 4.16, or use Acme (Pro) / Initech (Enterprise) |
| `400` from `/billing/portal/` | the workspace has no billing account yet: start a checkout first |
| `migrate` stops with `RuntimeError: Fix these … before migrating: …` | a schema-review migration found existing rows that break a new rule. It lists their ids and values and changes nothing: fix those rows (rename, re-enter or remove them by hand), then run `migrate` again |
| `404 Workspace not found.` right after deleting a workspace | expected: deletion hides it at once and finishes in the background (needs the Celery worker; the beat re-queues it every 10 min) |
| Docker: `connection refused` on 8080 | `docker compose ps`; wait for `backend` to be healthy, or check `docker compose logs backend` |
