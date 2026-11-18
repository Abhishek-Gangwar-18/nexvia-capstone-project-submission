# Individual Reflection

> **Draft.** This is a starting point built from what the project contains. A reflection must be in your own words,
> so edit every section, remove what doesn't match your experience, and fill in the `_…_` placeholders.

**Name:** _your name_
**Project:** FlowBoard, a multi-tenant SaaS project management platform
**Track:** Full-Stack Development
**Period:** 1 November 2026 – 20 November 2026

## 1. What I owned

_List what you personally designed and built. If you worked alone, say so._

- Tenant isolation design (shared schema with `workspace_id`) and the data models
- The REST API with Django REST Framework, JWT auth and role permissions
- The React + TypeScript frontend, including the drag-and-drop Kanban board and backlog
- Custom workflows, comments, attachments and the audit log
- Webhooks and background jobs (notifications, reports, email) with Celery
- Stripe Billing in test mode with plan limits
- Docker setup and the GitHub Actions pipeline
- Security hardening: production configuration, the httpOnly refresh cookie, token cleanup and a security audit
- The test suites (995 backend, 68 frontend, 26-check smoke test, 33 nginx security checks), Playwright browser tests, a k6 load test, a Lighthouse audit, and the documentation

## 2. What I learned

**Technical**
- How to keep tenants' data apart in one database, and why isolation has to fail closed.
- _e.g. how fractional ranking makes drag-and-drop cheap to save_
- _e.g. handling race conditions with row locks and unique constraints_
- _e.g. running background jobs with Celery and Redis, and making them safe to retry_
- _e.g. Stripe Checkout, webhooks and idempotent event handling_
- _e.g. writing tests that cover security, not just the happy path_
- _e.g. Docker Compose and CI/CD with GitHub Actions_

**Non-technical**
- _e.g. planning work in phases and finishing each one before starting the next_
- _e.g. writing documentation for other developers_

## 3. Hardest problem and how I solved it

_Pick one real problem. Describe what went wrong, what you tried, and what finally worked._

## 4. What I would do differently

- _e.g. write frontend tests from the start instead of adding them at the end_
- _e.g. plan the role matrix before building screens_
- _…_

## 5. What I'm proud of

- _e.g. tenant isolation that is proven by tests that attack it_
- _e.g. a full CI pipeline that tests, builds and deploys_

## 6. Next steps for my learning

- _e.g. WebSockets for real-time updates_
- _e.g. load testing and performance tuning_
