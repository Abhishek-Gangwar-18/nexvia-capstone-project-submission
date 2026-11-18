# FlowBoard: Test Results

Measured on **18 November 2026** on the local development machine (Windows 11, 20 logical CPUs). All numbers
below come from real runs. Everything except the API timings (§5) was re-run in the final verification after the
security hardening (production configuration, httpOnly refresh cookie, token cleanup, log redaction): backend and
frontend suites, Django checks, a full Docker rebuild, the smoke test and the nginx security checks. The API timings
are from the earlier run with the full Docker stack and haven't been re-measured since. How each suite works is described in
[API_TEST.md §8](API_TEST.md#8-automated-tests) and [ARCHITECTURE.md §11](ARCHITECTURE.md#11-testing-strategy).

## 1. Summary

| Suite | Tool | Tests | Result | Run time |
|---|---|---|---|---|
| Backend unit + API + concurrency + schema integrity + security | pytest-django on PostgreSQL 16 + Redis 7 | **983** | ✅ 983 passed, 0 failed | 18 min 45 s (1125 s, final verification run, serial; the previous run took 1158 s; includes real-thread race and migration tests) |
| Frontend unit + component | Vitest 3.2 + React Testing Library (jsdom) | **47** | ✅ 47 passed, 0 failed | ~5 s |
| End-to-end smoke (full Docker stack) | `scripts/smoke_test.py` through nginx | **26 checks** | ✅ 26/26 passed | a few seconds |
| nginx security (built frontend image) | `scripts/nginx_security_test.sh` | **33 checks** | ✅ 33/33 passed | ~30 s |
| Docker stack rebuild | `docker compose up -d --build --wait` | 6 services | ✅ all up, backend healthy | a few minutes |
| Django system check | `manage.py check` | n/a | ✅ no issues | n/a |
| Migration drift | `makemigrations --check --dry-run` | n/a | ✅ no changes detected | n/a |
| Type check + production build | `tsc -b` + `vite build` | n/a | ✅ no errors | ~6 s |

**Total automated tests: 1,030 (983 backend + 47 frontend), plus 26 end-to-end and 33 nginx security checks. All passing.**

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
| `accounts` | 29 | user model integrity, password reset, refresh token in an httpOnly cookie (cookie mode) |
| **Total** | **983** | |

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
| `src/lib/session.test.ts` | 16 | cookie refresh, Web Locks across tabs, session restore, logout only after a 204, no tokens broadcast |
| `src/store/auth.test.ts` | 4 | in-memory store, nothing persisted, legacy tokens removed |

## 4. End-to-end smoke test (26/26)

Runs against the real stack (nginx → gunicorn → PostgreSQL / Redis / Celery worker): login, projects, issues,
boards, sprints, dashboard, tenant isolation, role blocks, comments, attachment upload + download, a report built
by the Celery worker + CSV download, notifications, webhooks, billing, an unsigned Stripe webhook being rejected,
and the OpenAPI schema.

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

## 6. Frontend bundle

`pnpm build` output: the main app chunk is ~902 kB (≈275 kB gzipped); charts (Recharts) and drag-and-drop
(dnd-kit) are split into their own chunks. Vite warns that the main chunk is just over its 900 kB limit, so
route-level code splitting is a listed next step.

## 7. How to reproduce

```bash
cd backend && pytest                       # 983 tests (Postgres + Redis running)
cd frontend && pnpm test                   # 47 tests
docker compose up -d --build --wait
python scripts/smoke_test.py               # 26/26
sh scripts/nginx_security_test.sh          # 33/33
```
