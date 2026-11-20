# Nexvia Full-Stack Capstone: Project Submission

**Candidate:** Abhishek Gangwar

This repository holds both of my allotted projects. Each one is in its own folder with its complete source code, tests,
documentation and screenshots, and with its full commit history.

| # | Code | Project | Folder | Live demo | Demo video |
|---|---|---|---|---|---|
| 1 | **FS-01** | Multi-Vendor E-Commerce Marketplace (*Vendora*) | [`FS-01-multi-vendor-ecommerce-marketplace/`](FS-01-multi-vendor-ecommerce-marketplace/) | [nexvia-e-commerce.vercel.app](https://nexvia-e-commerce.vercel.app) | [Watch](DRIVE_LINK_FS01) |
| 2 | **FS-04** | Multi-Tenant SaaS Project Management Platform (*FlowBoard*) | [`FS-04-multi-tenant-saas-project-management/`](FS-04-multi-tenant-saas-project-management/) | Runs locally with one Docker command (see below) | [Watch](DRIVE_LINK_FS04) |

**All demo videos and supporting files:** [Google Drive folder](DRIVE_FOLDER_LINK)

---

## FS-01: Multi-Vendor E-Commerce Marketplace

An Amazon-style marketplace. Many sellers list products, customers buy from several stores in one checkout, and each
payment is split between the sellers and the platform's commission.

**Stack:** TypeScript · React 19 (Vite, Tailwind CSS v4, TanStack Query, Zustand) · Node.js + Express · MongoDB ·
Elasticsearch 8 · Redis · AWS S3 · Stripe (Payment Element + Connect) · Docker · Playwright

**Highlights**
- Three roles (customer, seller, admin), each with its own dashboard. Sellers go through onboarding and admin approval.
- Elasticsearch search with typo tolerance, synonyms, "Did you mean?" and faceted filters. It falls back to MongoDB if Elasticsearch is down.
- Multi-seller checkout that splits each order into packages per seller, holds the stock for 15 minutes while paying, and pays out to sellers through Stripe Connect.
- Live cart: price, stock and coupon changes reach an open cart within a second (MongoDB change streams + Server-Sent Events).
- Full order lifecycle: fulfilment, tracking, returns, refunds and payout release.
- Deployed: frontend on Vercel, API on Render, with MongoDB Atlas, Upstash Redis, Elastic Cloud and S3.

**Try it live:** [nexvia-e-commerce.vercel.app](https://nexvia-e-commerce.vercel.app)
- Customer: `customer@vendora.dev` / `Customer@123`
- Seller: `technova@vendora.dev` / `Vendor@123`
- Stripe test card: `4242 4242 4242 4242`, any future date, any CVC (no real money moves)

The API runs on Render's free plan, which sleeps when idle, so the first request can take about a minute.

**Testing:** 133 unit, 232 API integration and 24 security tests pass. 14 Playwright browser flows pass in Chromium,
Firefox and WebKit. A load test with 100 concurrent users had 0 errors. All 19 pages pass an axe-core accessibility check.

**Docs:** [README](FS-01-multi-vendor-ecommerce-marketplace/README.md) ·
[Architecture](FS-01-multi-vendor-ecommerce-marketplace/docs/ARCHITECTURE.md) ·
[Design decisions](FS-01-multi-vendor-ecommerce-marketplace/docs/DECISIONS.md) ·
[API tests](FS-01-multi-vendor-ecommerce-marketplace/docs/API_TESTS.md) ·
[Test results](FS-01-multi-vendor-ecommerce-marketplace/docs/TEST_RESULTS.md) ·
[Screenshots](FS-01-multi-vendor-ecommerce-marketplace/docs/screenshots/)

---

## FS-04: Multi-Tenant SaaS Project Management Platform

A Jira-like platform. Every company gets its own isolated workspace with projects, Kanban and scrum boards, sprints,
custom workflows and billing.

**Stack:** Python 3.13 · Django 5.2 + Django REST Framework · React 19 + TypeScript (Vite) · PostgreSQL 16 ·
Celery + Redis · Stripe Billing · pytest + Vitest + Playwright · Docker · GitHub Actions

**Highlights**
- Multi-tenancy with a `workspace_id` on every row, enforced at the request, query and write layers. Data from another tenant returns 404.
- Four roles (owner, admin, member, viewer), enforced in the API's services and reflected in the UI.
- Drag-and-drop Kanban, backlog and sprints, a custom workflow editor, comments with mentions, file attachments and an audit log.
- Celery background jobs: signed webhooks with retries and SSRF protection, email notifications, and burndown and velocity reports.
- Stripe Billing (test mode) with Free, Pro and Enterprise plans, plan limits (HTTP 402) and double-charge protection.
- Production Docker images (gunicorn + nginx) and a GitHub Actions CI/CD pipeline.

**Run it:**
```bash
cd FS-04-multi-tenant-saas-project-management
cp .env.example .env
docker compose up -d --build      # then open http://localhost:8080
```
Demo accounts (password `Demo@1234`): `owner@acme.test`, `admin@acme.test`, `viewer@acme.test`. The login page also
has one-click demo accounts.

**Testing:** 995 backend tests (pytest on real PostgreSQL + Redis), 68 frontend tests (Vitest), 7 Playwright browser
tests covering 8 user flows, 26/26 smoke checks and 33/33 nginx security checks. A k6 load test at 50 users had 0% errors
with a p95 of 71 ms. Lighthouse accessibility score: 100.

**Docs:** [README](FS-04-multi-tenant-saas-project-management/README.md) ·
[Architecture](FS-04-multi-tenant-saas-project-management/docs/ARCHITECTURE.md) ·
[API docs and tests](FS-04-multi-tenant-saas-project-management/docs/API_TEST.md) ·
[Test results](FS-04-multi-tenant-saas-project-management/docs/TEST_RESULTS.md) ·
[Screenshots](FS-04-multi-tenant-saas-project-management/docs/screenshots/)

---

## Repository structure

```
├── FS-01-multi-vendor-ecommerce-marketplace/     Project 1: client/, server/, e2e/, docs/, docker-compose.yml
├── FS-04-multi-tenant-saas-project-management/   Project 2: backend/, frontend/, e2e/, load/, scripts/, docs/, docker-compose.yml
└── README.md                                     this file
```

Each project is self-contained. Run its commands from inside its own folder, as described in its README.

## Commit history

Both projects were built in their own repositories and merged here with `git subtree`, which keeps every original
commit. To see one project's history:

```bash
git log --oneline -- FS-01-multi-vendor-ecommerce-marketplace
git log --oneline -- FS-04-multi-tenant-saas-project-management
```

Original repositories:
[nexvia_e-commerce](https://github.com/Abhishek-Gangwar-18/nexvia_e-commerce) ·
[nexvia_multi-tenant-saas-platform](https://github.com/Abhishek-Gangwar-18/nexvia_multi-tenant-saas-platform)

FS-04's GitHub Actions pipeline (`.github/workflows/ci.yml`) runs in its original repository. GitHub only runs
workflows from a repository's root `.github/` folder, so it does not run from the subfolder here.
