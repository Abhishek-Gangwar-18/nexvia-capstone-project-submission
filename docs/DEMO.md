# FlowBoard: Demo Script

A script for the working demo (live or screen-recorded). Target length: **6–7 minutes**, so it fits inside the
10-minute presentation ([PRESENTATION.md](PRESENTATION.md)).

**Demo video:** _add link here after recording_
**Live URL (if deployed):** _add link here_

## Before recording

```bash
docker compose up -d --build --wait
docker compose exec backend python manage.py seed_demo --reset   # fresh demo data
python scripts/smoke_test.py                                       # confirm 26/26 before you record
```

- Open http://localhost:8080 in a clean browser window, zoom to 110–125% so text is readable on video.
- Have the Stripe test card ready: `4242 4242 4242 4242`, any future date, any CVC.
- Optional: a second browser (or private window) for the second user.
- Every demo password is `Demo@1234`.

## Script

| # | Time | Account | What to show | What to say |
|---|---|---|---|---|
| 1 | 0:00 | (logged out) | Home page → **Log in** → one-click demo accounts | "FlowBoard is a Jira-like tool where every company gets its own isolated workspace." |
| 2 | 0:30 | `owner@acme.test` | Dashboard: charts, counts, recent activity | "Each workspace has its own dashboard built from its own data only." |
| 3 | 1:00 | owner@acme | Project **WEB** → **Board**: drag a card to another column, refresh the page | "Drag and drop is saved to the server with ranking, so the order persists after refresh." |
| 4 | 1:45 | owner@acme | Open an issue: comment with an @mention, upload an attachment, show the activity history | "Comments, attachments and a full activity history on every issue." |
| 5 | 2:30 | owner@acme | **Backlog**: drag issues into a sprint, start the sprint | "Sprints are planned from the backlog; only one sprint can be active per project." |
| 6 | 3:00 | owner@acme | **Workflow** page: add a status and a transition rule | "Each project can have its own custom workflow." |
| 7 | 3:30 | owner@acme | **Audit log** page: filter by action | "Every important change is recorded in the audit log." |
| 8 | 3:50 | owner@acme | **Settings → Webhooks**: add an endpoint, show the one-time secret, send a test | "Webhooks are signed and sent by Celery background workers, with retries." |
| 9 | 4:20 | owner@acme | **Reports**: generate a report, download the CSV | "Reports are built in the background by Celery." |
| 10 | 4:45 | `alex@flowboard.test` | Workspace switcher: Acme ↔ Globex, show different projects | "One user can belong to several workspaces; data never mixes." |
| 11 | 5:15 | `viewer@acme.test` | Board is read-only, no create/delete buttons | "Roles: owner, admin, member, viewer. The UI only shows what the API allows." |
| 12 | 5:45 | `owner@globex.test` | Create projects until the Free plan limit → upgrade prompt → **Billing** → Stripe test checkout | "Stripe Billing in test mode enforces plan limits." |
| 13 | 6:30 | (terminal / browser) | GitHub Actions run (green), `pnpm test`, `pytest` summary | "CI runs 924 backend tests, 29 frontend tests and a 26-check end-to-end test on every push." |
| 14 | 7:00 | n/a | Dark mode toggle, end | n/a |

## Fallbacks

| Problem | Fix |
|---|---|
| Login says too many attempts (429) | `docker compose exec backend python manage.py shell -c "from django.core.cache import cache; cache.clear()"` |
| Billing says it is not configured | Add Stripe test keys to `.env` and `docker compose up -d`; or skip step 12 and show the limit prompt only |
| Report stays "pending" | Check the worker: `docker compose logs worker` |
| Demo data looks changed | `docker compose exec backend python manage.py seed_demo --reset` |
