# FlowBoard: Test Results

Measured on **18–19 November 2026** on the local development machine (Windows 11, 20 logical CPUs). All numbers
below come from real runs. Everything except the API timings (§5) was re-run in the final verification, plus a fresh clone test (§4a), after the
security hardening (production configuration, httpOnly refresh cookie, token cleanup, log redaction): backend and
frontend suites, Django checks, a full Docker rebuild, the smoke test and the nginx security checks. The API timings
are from the earlier run with the full Docker stack and haven't been re-measured since. The browser end-to-end
tests (§4b), the load test (§5a) and the frontend performance and accessibility audit (§6a) were run last, on an
isolated copy of the stack (`docker compose -p flowboard-e2e`, port 18081, its own database); the issues they found
are listed in §8 and are fixed. How each suite works is described in
[API_TEST.md §8](API_TEST.md#8-automated-tests) and [ARCHITECTURE.md §11](ARCHITECTURE.md#11-testing-strategy).

## 1. Summary

| Suite | Tool | Tests | Result | Run time |
|---|---|---|---|---|
| Backend unit + API + concurrency + schema integrity + security | pytest-django on PostgreSQL 16 + Redis 7 | **995** | ✅ 995 passed, 0 failed | 19 min 26 s (1166 s, last full run, serial; includes real-thread race and migration tests) |
| Frontend unit + component | Vitest 3.2 + React Testing Library (jsdom) | **68** | ✅ 68 passed, 0 failed | ~15 s |
| Browser end-to-end (8 user flows) | Playwright 1.56, Chromium, real stack + Stripe sandbox | **7 tests** | ✅ 7/7 passed (stable on repeat runs) | ~2 min |
| API load test | k6 0.54, 1 → 50 concurrent users | 17,747 requests | ✅ 0% errors, p95 71 ms, p99 103 ms | ~5 min |
| Accessibility audit | Lighthouse 12.8, light + dark mode, 7 pages | 14 audits | ✅ 100 on every page in both themes | ~5 min |
| End-to-end smoke (full Docker stack) | `scripts/smoke_test.py` through nginx | **26 checks** | ✅ 26/26 passed | a few seconds |
| nginx security (built frontend image) | `scripts/nginx_security_test.sh` | **33 checks** | ✅ 33/33 passed | ~30 s |
| Docker stack rebuild | `docker compose up -d --build --wait` | 6 services | ✅ all up, backend healthy | a few minutes |
| Fresh clone test (new user's first run) | clean `git clone` + `.env.example`, `build --no-cache`, empty volumes, smoke test | 84 migrations, demo data, 26 checks | ✅ all migrations applied, demo data loaded, 26/26 | ~5 min |
| Django system check | `manage.py check` | n/a | ✅ no issues | n/a |
| Migration drift | `makemigrations --check --dry-run` | n/a | ✅ no changes detected | n/a |
| Type check + production build | `tsc -b` + `vite build` | n/a | ✅ no errors | ~6 s |

**Total automated tests: 1,063 (995 backend + 68 frontend), plus 7 browser end-to-end tests, 26 smoke checks and 33 nginx
security checks. All passing.**

The same suites run in GitHub Actions on every push and pull request (`.github/workflows/ci.yml`).

## 2. Backend tests by app

| App | Tests | Main areas covered |
|---|---|---|
| `core` | 331 | tenant isolation (query + write), API for projects/issues/sprints/boards, roles, invitations, dashboard, reports, audit, email, robustness against malformed input; production settings and log redaction |
| `issues` | 130 | comments, attachments (file signatures, cleanup), hierarchy and cycles, label rules, list caps, trigram search index, audit paging |
| `tenants` | 101 | owner/admin role matrix, ownership transfer, workspace delete, slug races, invitations, throttles |
| `projects` | 166 | project delete rules, archived read-only, key races, sprint lock order, workflows, WIP limits; schema review: issue-counter and sprint lost-update races, project-workflow triggers, transition composite FKs, board WIP JSON checks |
| `automation` | 127 | webhook signing, SSRF protection, retries and auto-disable, delivery claims, notifications digest, report dedupe; schema review: claim-token fencing, redelivery retention, endpoint PATCH races, report lifecycle, notification indexes; nightly expired-token cleanup |
| `billing` | 99 | plan limits, Checkout/Portal, Stripe webhook signatures, idempotency, concurrent checkout, plan sync; schema review: subscription integrity, apply-time webhook failures returned as 500 |
| `accounts` | 41 | user model integrity, password reset, refresh token in an httpOnly cookie (cookie mode), layered refresh rate limits and the spoofed `X-Forwarded-For` fix |
| **Total** | **995** | |

Notable test types:
- **Cross-tenant attacks:** a user in workspace A tries to read or write workspace B's data by id, by header switching and through foreign ids in payloads. All are rejected with 404/400.
- **Race conditions:** real threads and separate DB connections for checkout, webhook endpoint caps, report dedupe and `skip_locked` delivery claims.
- **Performance guards:** query-count assertions on hot endpoints and `EXPLAIN` checks that the issue search, delivery history, notification inbox and retention batches use their indexes.
- **Schema integrity (one `test_<table>_table.py` per table):** every CHECK, unique index, composite FK and trigger is hit through raw SQL and bulk writes; each migration's "report and stop" path is tested by migrating back and forward.

## 3. Frontend tests

| File | Tests | What it proves |
|---|---|---|
| `src/lib/utils.test.ts` | 15 | Kanban rank math for drag and drop, API error → message mapping, 402 plan-limit detection, date/overdue helpers |
| `src/pages/auth/LoginPage.test.tsx` | 9 | open-redirect guard (6 cases), login submit → redirect, error display, signed-in users skip the form |
| `src/components/ui/Button.test.tsx` | 3 | click handling, disabled while loading, accessible labels |
| `src/lib/session.test.ts` | 25 | cookie refresh, Web Locks across tabs, session restore, logout only after a 204, no tokens broadcast; a 429 keeps the session, `Retry-After` parsing, retry after the limit resets, a 429 inside the cross-tab lock releases it |
| `src/components/settings/AutomationSections.test.tsx` | 7 | webhook deliveries refresh while in flight and stop when terminal, Redeliver (success, refused with the server's reason), no button on delivered or in-flight rows, disabled endpoint, test event opens the list, non-admins see nothing |
| `src/App.test.tsx` | 3 | session screen: 429 shows the rate-limit message with a countdown and retries by itself; network trouble shows the connection message; 401 goes to login |
| `src/pages/project/BoardPage.test.tsx` | 2 | board and backlog with no data / no active sprint stop rendering (regression for the render loop in §8) |
| `src/store/auth.test.ts` | 4 | in-memory store, nothing persisted, legacy tokens removed |

## 4. End-to-end smoke test (26/26)

Runs against the real stack (nginx → gunicorn → PostgreSQL / Redis / Celery worker): login, projects, issues,
boards, sprints, dashboard, tenant isolation, role blocks, comments, attachment upload + download, a report built
by the Celery worker + CSV download, notifications, webhooks, billing, an unsigned Stripe webhook being rejected,
and the OpenAPI schema.

## 4a. Fresh clone test

Checks that someone new can run the project from GitHub alone, with nothing from the development machine: no
existing `.env`, database volume, cached image layers, virtual environment or `node_modules`.

| Step | Result |
|---|---|
| `git clone` of `main` (commit `31f337c`) into an empty folder, `cp .env.example .env` | ✅ |
| `docker compose -p flowboard-fresh config` with overrides: `:test` image tags, ports 55432 / 56380 / 18080 | ✅ separate project, images, volumes and network |
| `docker compose -p flowboard-fresh build --no-cache` (backend + frontend) | ✅ both built (one PyPI download error on the first attempt; the no-cache retry succeeded) |
| `up -d --wait` on empty volumes | ✅ all 6 services up, backend and frontend healthy |
| Migrations on an empty database | ✅ 84 applied, 0 pending |
| Demo data loaded on first start | ✅ workspaces `acme`, `globex`, `initech`; 23 users, 336 issues |
| `python scripts/smoke_test.py http://localhost:18080` | ✅ 26/26 |
| Cleanup: `docker compose -p flowboard-fresh down -v`, test images and clone removed | ✅ the existing development stack and its data were untouched |

How to run it yourself without touching an existing stack (the compose file sets `name: flowboard`, so always
pass a different `-p`, also on `down -v`):

```bash
git clone <repo-url> flowboard-fresh-clone && cd flowboard-fresh-clone && cp .env.example .env
export BACKEND_IMAGE=flowboard-fresh-backend:test FRONTEND_IMAGE=flowboard-fresh-frontend:test \
       POSTGRES_HOST_PORT=55432 REDIS_HOST_PORT=56380 APP_HTTP_PORT=18080
docker compose -p flowboard-fresh build --no-cache
docker compose -p flowboard-fresh up -d --wait
python scripts/smoke_test.py http://localhost:18080
docker compose -p flowboard-fresh down -v && docker rmi flowboard-fresh-backend:test flowboard-fresh-frontend:test
```

## 4b. Browser end-to-end tests (Playwright, 7/7)

`e2e/tests/flows.spec.ts` drives Chromium through the real app as one new owner, with two invited teammates in their
own browser contexts. Everything is created fresh per run, so the suite can be re-run on the same stack.

| Flow | What is checked | Result |
|---|---|---|
| 1. Authentication | register; reload restores the session; `fb_refresh` is HttpOnly + SameSite=Strict and not readable from JavaScript; refresh rotates it; change password; logout clears the cookie and protected pages redirect to login; login with the new password | ✅ |
| 2. Workspaces | create a second workspace and switch back; invite two people who join through the invite link; change a role; remove a member | ✅ |
| 3. Projects | create a scrum project (its board comes with it); walk Backlog → Issues → Board → Workflow without reloading; add a workflow status, save, reload and check it stuck | ✅ |
| 4–5. Sprints and issues | create a sprint; create an issue assigned to a teammate, with a priority, in the sprint; start the sprint; change priority; move the status (still moved after a reload); comment with an @mention; upload a file; complete the sprint | ✅ |
| 6. Automation | add a webhook (secret shown once); send a test event; the delivery list follows it until it fails after its retries (the target never resolves, so nothing is sent anywhere); Redeliver queues a new attempt | ✅ |
| 7. Billing | upgrade to Pro on Stripe's sandbox Checkout with Stripe's published test card; back in the app the plan shows Pro | ✅ |
| 8. Reports and notifications | generate a report and download the CSV; the teammate sees an unread count and "Mark all read" clears it | ✅ |

Not covered: Stripe can't send webhooks to a local machine, so the upgrade is confirmed by the app's own sync on
return from Checkout; and a successful webhook delivery needs a public receiver, so only the failure, retry and
redeliver path is tested.

## 5. API performance

Method: 50 sequential requests per endpoint after 3 warm-up calls, as `owner@acme.test` on the `acme` demo workspace
(seeded data), through nginx on `http://localhost:8080`. Latency is measured client-side from request start until
the full response body is read.

| Endpoint | p50 (ms) | p95 (ms) | max (ms) |
|---|---|---|---|
| `GET /api/auth/me/` | 6.3 | 7.7 | 11.8 |
| `GET /api/boards/` | 10.0 | 18.9 | 29.8 |
| `GET /api/notifications/` | 11.5 | 13.5 | 17.6 |
| `GET /api/sprints/` | 12.5 | 31.9 | 44.6 |
| `GET /api/audit-log/` | 14.5 | 26.7 | 38.8 |
| `GET /api/projects/` | 19.1 | 33.6 | 169.9 |
| `GET /api/issues/?project=WEB&page_size=50` | 35.4 | 56.0 | 214.3 |
| `GET /api/dashboard/` (aggregates) | 56.3 | 73.5 | 88.2 |

**Takeaways**
- Every measured endpoint has a median under 60 ms and p95 under 75 ms.
- The dashboard is the slowest because it aggregates counts across the workspace. It is still well under 100 ms at p95.
- The occasional max of 170–215 ms on lists is a one-off outlier (p95 stays under 60 ms), most likely a cold
  cache or the Celery worker sharing the same machine.
- These are single-user, local-machine numbers, not a load test.

## 5a. Load test (k6)

`load/k6-api.js`: signed-in users browse (me, projects, board, board issues, dashboard, notifications) with 1–3 s
think time, and 30% of iterations create and update an issue. Users ramp 1 → 10 → 25 → 50 and back; alongside, a
login + refresh flow runs at 4/min and four reports are generated. A webhook endpoint is subscribed to issue events,
so the worker also delivers webhooks during the run. Run against the isolated stack with demo-sized data.

| Metric | Result |
|---|---|
| Requests / errors | 17,747 requests, **0% errors**, all checks passed |
| Throughput | ~60 requests/s at the 50-user peak profile |
| Latency, all requests | p50 20 ms · p95 71 ms · p99 103 ms |
| Reads / writes p95 | 70 ms / 69 ms |
| Login / refresh p95 | 200 ms / 41 ms |

Server-side p95 per endpoint: dashboard 69 ms, issue update 42 ms, issue create 33 ms, board issues 26 ms, projects
20 ms, boards 8 ms, notifications 7 ms, me 3 ms. Reports were built by the worker; webhook deliveries ran and retried.

Finding: `GET /issues/?project=` returns the whole list (capped at 1,000 rows, `X-Truncated: true`) rather than
pages. In an earlier run where repeated load tests had grown one project past 1,000 issues, each response was about
600 KB and read p95 rose to 708 ms with the stack's 3 gunicorn workers. The board loads only the active sprint, so
this matters for very large projects' "Issues" view; paginating it is a listed next step.

## 6. Frontend bundle

`pnpm build` output: the main app chunk is ~902 kB (≈275 kB gzipped); charts (Recharts) and drag-and-drop
(dnd-kit) are split into their own chunks. Vite warns that the main chunk is just over its 900 kB limit, so
route-level code splitting is a listed next step.

## 6a. Frontend performance and accessibility (Lighthouse)

| Page | Performance (desktop / mobile) | FCP (desktop / mobile) | LCP (desktop / mobile) | CLS |
|---|---|---|---|---|
| Home | 96 / 59 | 0.9 s / 4.1 s | 1.0 s / 4.8 s | 0.004 |
| Login | n/a / 75 | n/a / 4.0 s | n/a / 4.4 s | 0 |
| Dashboard | 98 / n/a | 0.8 s | 0.9 s | 0 |
| Board | 98 / 70 | 0.8 s / 4.2 s | 0.9 s / 4.5 s | 0.003 |

Mobile scores use Lighthouse's simulated slow 4G and mid-range phone. The main bundle is 904 KB raw (326 KB gzipped)
and about 350 KB of JavaScript is unused on first load, which is what holds mobile back; route-level code splitting
is the listed next step.

Interaction latency (INP-style, Event Timing measured in Playwright): open board 48 ms, open issue drawer 16 ms, open
create dialog 64 ms, typing 112 ms, switching tabs 24–32 ms; all under the 200 ms "good" threshold. No browser
console errors apart from the expected 401 when a logged-out page checks for a session.

**Accessibility:** after the fixes in §8, Lighthouse scores **100** on Home, Login, Dashboard, Board, Backlog,
Settings and Members, in **both light and dark mode** (before: 84–95, dark mode only). Keyboard checks in the
browser: a logical tab order with a visible focus indicator on every element; menus open with Enter, close with
Escape and return focus; the create dialog opens with `C`, is named by its title, keeps focus inside and closes with
Escape.

## 7. How to reproduce

```bash
cd backend && pytest                       # 995 tests (Postgres + Redis running)
cd frontend && pnpm test                   # 68 tests
docker compose up -d --build --wait
python scripts/smoke_test.py               # 26/26
sh scripts/nginx_security_test.sh          # 33/33
```

Browser end-to-end and load tests run against an isolated stack, never your development data (they register users
and create workspaces, issues, webhooks and reports):

```bash
export POSTGRES_HOST_PORT=55433 REDIS_HOST_PORT=56381 APP_HTTP_PORT=18081 \
       APP_FRONTEND_URL=http://localhost:18081 APP_CSRF_TRUSTED_ORIGINS=http://localhost:18081
docker compose -p flowboard-e2e up -d --build --wait
cd e2e && pnpm install && pnpm exec playwright install chromium && pnpm test     # 7 tests, ~2 min
docker run --rm -i --network container:flowboard-e2e-frontend-1 -e BASE=http://localhost \
  -v "$PWD/../load:/scripts" grafana/k6:0.54.0 run /scripts/k6-api.js           # ~5 min
docker compose -p flowboard-e2e down -v                                          # always with -p
```

Clear the stack's rate-limit counters between repeated runs (registration is limited to 10/hour per IP):
`docker compose -p flowboard-e2e exec backend python manage.py shell -c "from django.core.cache import cache; cache.clear()"`.

## 8. Issues found by these tests (all fixed)

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | High | On a scrum board with no active sprint (every new scrum project, and any project between sprints) the tabs changed the URL but the board stayed on screen until a reload. Cause: a fresh `[]` default for the disabled issues query fed a state-syncing effect, so the board re-rendered forever and starved navigation. The backlog had the same loop while loading | Stable shared empty arrays in `BoardPage` and `BacklogPage`; regression test that fails fast on a render loop; E2E walks the tabs without reloading |
| 2 | Medium | Every page load refreshes the session, and refresh was limited to 30/min **per IP**, so an office behind one NAT address (or one user with many tabs) got "We couldn't reach FlowBoard", which also misdescribed a rate limit | Layered limits: 30/min per verified account, 30/min per IP for invalid tokens, 600/min per IP ceiling, all in shared Redis. A 429 keeps the session and shows a rate-limit message that counts down `Retry-After` and retries |
| 2a | Medium (security) | Found while fixing #2: DRF used the whole `X-Forwarded-For` header as the client IP, so sending a different value per request escaped every per-IP limit (login, register, refresh, reset) | Behind nginx only the last entry (added by nginx) is trusted (`NUM_PROXIES=1` when `DJANGO_BEHIND_PROXY` is set) |
| 3 | Low | The webhook delivery list didn't refresh while a delivery was retrying, and there was no way to redeliver from the UI | The list updates itself while deliveries are in flight; failed deliveries have a Redeliver button (existing API, admins only, disabled for disabled endpoints) |
| 4 | Low | Accessibility: colour contrast in both themes, the issue drawer and the mobile Create button had no accessible name, ARIA on menu wrappers, two unlabelled inputs, small checkbox targets, heading order | WCAG AA colours, names and roles fixed; Lighthouse 100 everywhere |
