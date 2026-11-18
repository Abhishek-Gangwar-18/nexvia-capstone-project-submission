# FlowBoard: Final Presentation Outline (10 minutes)

Covers the five required parts: **problem, design, challenges, results, next steps**. Times are a guide.

| # | Section | Time | Slides |
|---|---|---|---|
| 1 | Problem | 1:00 | 1 |
| 2 | Design | 2:00 | 2–3 |
| 3 | Live demo | 4:00 | (see [DEMO.md](DEMO.md), short version) |
| 4 | Challenges | 1:30 | 1 |
| 5 | Results | 1:00 | 1 |
| 6 | Next steps + Q&A | 0:30 | 1 |

---

## 1. Problem (1 min)

- Teams need a Jira-like tool: boards, sprints, workflows, collaboration.
- As a **SaaS**, many companies share one deployment, so each company's data must be **fully isolated**.
- It also needs the business side: roles, plans, paid subscriptions and limits.
- Goal: a production-style multi-tenant platform built in 7 milestones.

## 2. Design (2 min)

**Stack:** Django REST Framework · React 19 + TypeScript · PostgreSQL · Celery + Redis · Stripe · Docker · GitHub Actions.

**Tenant isolation:** shared database, shared schema, `workspace_id` on every tenant table.
- `TenantModel` + `TenantQuerySet` scope every query; queries fail closed without a workspace.
- Writes reject foreign ids (e.g. a status or sprint from another workspace).
- Workspace chosen per request with the `X-Workspace` header, checked against membership.

**Data model:** Workspace → Membership (role) → Project → Board / Workflow / Sprint → Issue → Comments, Attachments, AuditLog.

**Show:** the architecture diagram from [ARCHITECTURE.md](ARCHITECTURE.md) (mermaid diagrams render on GitHub).

**A note on the tech stack:** the brief's tool list names Express and Prisma, but milestone 2 asks for Django REST
Framework and milestone 5 for Celery. The milestones were followed, so the backend is Django. Vitest is used for
the frontend tests as listed.

## 3. Live demo (4 min)

Short version of [DEMO.md](DEMO.md): steps 2, 3, 4, 5, 10, 11, 12.

## 4. Challenges (1.5 min)

Pick the 3 you can explain best:

| Challenge | Solution |
|---|---|
| Data leaking between tenants | Tenant-aware query manager that fails closed, plus validation of every foreign id, plus cross-tenant attack tests |
| Drag-and-drop ordering without renumbering every card | Fractional ranks (`rank_between`) with periodic rebalancing, mirrored in the frontend |
| Race conditions (double checkout, duplicate reports, webhook caps) | Row locks with a consistent lock order, unique constraints, `skip_locked` claims, tested with real threads |
| Webhook security | HMAC signatures with timestamps, a show-once secret, SSRF blocking with IP pinning, retries and auto-disable |
| Stripe in test mode without public webhooks locally | Signed webhooks in production plus a `/billing/sync/` endpoint for local development; idempotent event handling |
| Keeping login sessions safe from page scripts | Refresh token in an httpOnly SameSite=Strict cookie, access token in memory only, Web Locks so tabs don't revoke each other's rotating tokens, and reset/invite tokens redacted from logs |
| Keeping the UI honest about permissions | The UI shows only actions the API allows for the role; the API enforces it anyway |

## 5. Results (1 min)

- All **7 milestones** delivered.
- **983 backend tests**, **47 frontend tests**, **26/26** end-to-end checks: all passing, run in CI on every push.
- Production hardening: admin IP allowlist, strict CSP, HSTS, API docs off, and a security audit with no open findings.
- API medians **6–56 ms**, p95 under **75 ms** on the demo data (see [TEST_RESULTS.md](TEST_RESULTS.md)).
- Dockerized stack (Postgres, Redis, Django, Celery worker + beat, nginx) with a deploy job on `main`.

## 6. Next steps (30 s)

- Real-time board updates (WebSockets / Django Channels).
- Route-level code splitting to shrink the main frontend bundle.
- Run the nginx security checks in CI and add a Redis password in production.
- More frontend tests (board drag-and-drop, issue drawer) and browser end-to-end tests (Playwright).
- Load testing (e.g. Locust) and caching for the dashboard.
- Import real seed data from the public Jira dataset.

## Likely questions

| Question | Short answer |
|---|---|
| Why shared schema and not schema-per-tenant? | Simplest to operate and migrate, works with one connection pool; isolation is enforced in code and tested |
| Why Django instead of Express/Prisma? | The milestones ask for DRF and Celery |
| What happens if Redis is down? | Rate limits need it; background jobs fail gracefully and are tested for broker outages |
| Where are the tokens stored in the browser? | Refresh token in an httpOnly cookie scoped to `/api/auth/`, access token in memory; nothing in localStorage |
| How do you know tenants are isolated? | Dedicated tests try to read and write across workspaces through every route |
