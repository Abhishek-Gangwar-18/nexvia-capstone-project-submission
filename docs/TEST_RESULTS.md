# Vendora: test results and performance

Pre-submission audit, **19 November 2026**, on `main`. Every number here comes from a real run; how to repeat each one
is at the end. Bugs the audit found were fixed and re-tested; the few open items are listed under *Known limitations*.

## Summary

| Area | Result |
|---|---|
| Type checks (API and client), production build | **0 errors**, build passes |
| API unit tests (`node:test`, no database) | **133 / 133** pass |
| API integration suite (every endpoint, happy and error cases) | **232 / 232** pass |
| Security suite (injection, access control, payment forgery, headers, limits) | **24 / 24** pass |
| Browser end-to-end tests (Playwright) | **14 / 14** flows in Chromium, Firefox and WebKit; Stripe test cards **2 / 2** |
| Responsive layout (phone, tablet, desktop × light, dark) | **17 pages** fit every size, no sideways scrolling |
| Accessibility (axe-core, WCAG 2.1 A/AA) | **19 / 19 pages** with no violations; keyboard-only use and focus trapping pass |
| Live services (`redis:check`, `es:check`, `s3:check`) | all pass |
| Fresh clone from GitHub, README only, Docker | runs with one command; 12 / 12 browser flows pass on it |
| Production config guards | **7 / 7** unsafe configurations refused at startup |
| Live deployment (Vercel + Render) | frontend and API deployed separately; health, HTTPS, headers, CORS and webhook signatures checked; a real Stripe test-card order paid on the live site |
| Load test (100 concurrent users) | **0 errors** in ~40,000 requests |
| Lighthouse (desktop) | performance 97–98, accessibility 91–100, best practices 100, SEO 100 |

## Test environment

| Item | Value |
|---|---|
| Machine | Windows 11 laptop, Docker Desktop (Docker 29.9, 20 CPUs, 8 GB for Docker) |
| Runtime | Node.js 24.18 (local), `node:24-alpine` (containers), nginx 1.27 |
| Stack under test | A **throwaway** `docker compose` stack: `api`, `web` (nginx), Redis 7, Elasticsearch 8.19, MongoDB 7 as a single-node **replica set** (so transactions and change streams behave like Atlas) |
| Data | Demo seed: 5 stores, 20 customers, 184 products, ~1,170 reviews, 210 orders, 6 coupons, plus an audit admin account |
| Payments | Built-in test gateway, and separately Stripe **test mode** (real `sk_test_` keys and the real webhook signing secret) |
| Browsers | Chromium 140, Firefox 141, WebKit 26 (Safari's engine) via Playwright 1.55 |

No test touched the Atlas database or production data. Live service checks touch only their own service (a temporary
Redis key, a temporary Elasticsearch index, one test image in S3 that is deleted again).

---

## 1. Automated test suites

### Unit tests: 133 / 133 (`pnpm --dir server test`)

No database or external services: models, Redis, Elasticsearch and Stripe are faked.

| File | What it covers |
|---|---|
| `orders.test.ts` | Package status rules, package locks, refunds when a package is cancelled, refund retry never pays twice |
| `payments.test.ts` | Payment capture confirmation, payment status after returns, payout reversal |
| `returns.test.ts` | Return requests (limits, duplicates), refund summaries, payout job racing a return |
| `pricing.test.ts` | Free-shipping threshold, every coupon rule (dates, limits, minimum order, store-only), discount caps, splitting a discount across packages so it adds up exactly, commission and seller earning rounding |
| `cart.test.ts` | Totals, savings, shipping; quantity capped by stock and the 10-per-item limit; price-change notices; removed or suspended products leaving the cart; 50-product limit |
| `auth.test.ts` | Missing, forged, edited, `alg: none` and expired tokens; ended sessions; tokens from before a password change; blocked accounts; role checks; seller approval gate |
| `coupons-webhooks.test.ts` | Coupon use per customer and overall, two checkouts racing for the last use, use given back on cancel; Stripe events processed once, failed deliveries retried |
| `cache.test.ts` | Locks and rate-limit store, in memory and with Redis, including a dropped connection |
| `search.test.ts` | Elasticsearch index build, searching, fallback to MongoDB and recovery |
| `blocked.test.ts`, `adminOrders.test.ts`, `uploads.test.ts`, `startup.test.ts` | Blocked accounts, admin order filters and CSV export, image type checks, app startup and production safety checks |

### API integration: 232 / 232 (`pnpm --dir server test:integration`)

Every case of [API_TESTS.md](API_TESTS.md) run automatically against the running stack, in order, plus about 30 extra
checks. Highlights:

- **Auth:** registration rules, login, refresh-cookie rotation (a replayed old cookie after the 30 s grace window ends
  the whole session), sessions, password change ends old tokens, logout everywhere.
- **Shopping:** catalogue filters and sorting, typo search, suggestions, wishlist, cart rules, coupons (a coupon the
  customer already used is no longer suggested to them), checkout idempotency, the client can't set prices.
- **Orders and payments:** pay, decline and retry, cancel with refund and restock, invoices (PDF), two checkouts at
  the same moment create one order.
- **Sellers and admins:** onboarding and approval, products, package status rules, review replies, coupons, blocking
  users, moderation, categories, settings, CSV export without personal data, search reindex.
- **Outages** (run by stopping containers): Redis down → browsing and login keep working, checkout answers 503 and
  works again when Redis is back; Elasticsearch down → search falls back to MongoDB, index rebuilt on recovery;
  MongoDB down → `503` with `Retry-After`, never a 500, back within ~2 s.
- **Race against the real database:** 5 customers checking out at the same moment with a coupon that has 1 use left →
  exactly 1 gets the discount.

### Security: 24 / 24 (`pnpm --dir server test:security`)

| Area | Checked |
|---|---|
| Secrets | Full git history (60 commits): no Stripe, AWS, MongoDB or JWT secrets ever committed; `render.yaml` holds none |
| Injection | NoSQL operators in login and query strings rejected; regex-like search text matched literally and fast; `/uploads/../` path traversal blocked; user HTML stored as text (the client has no raw-HTML sinks) |
| Payment forgery | In Stripe mode the client can't mark an order paid; webhooks without a valid signature, with an hour-old replayed signature or a tampered body are rejected; a correctly signed event is accepted |
| Mass assignment | Sellers can't set sales, ratings, owner, their own approval or commission; client prices, totals and discounts ignored |
| Access control | Customers can't reach each other's orders, payments or returns; sellers can't reach each other's orders, coupons or returns; no response contains password hashes, token hashes, bank numbers or API keys |
| Transport | Security headers on the API (helmet) and the web app (nginx, Vercel); foreign CORS origins refused quietly; JSON over 1 MB → 413; images over 5 MB refused; malformed JSON → 400 |
| Rate limits | Login limited to 50 attempts per 15 minutes per address; a spoofed `X-Forwarded-For` does not get around it |

### Browser end-to-end (`pnpm --dir e2e test`)

| Spec | Flows | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| `customer` | Search → product → cart → coupon → checkout → pay → order → PDF invoice; declined payment then retry; wishlist, orders, account | ✅ | ✅ | ✅ |
| `seller` | Dashboard; publish a product with an image upload; take an order through packed → shipped → delivered; payouts, reviews, coupons, returns, settings | ✅ | ✅ | ✅ |
| `admin` | Analytics charts and all 10 console pages; approve a new seller's application | ✅ | ✅ | ✅ |
| `guards` | Wrong password; sign up and sign out; guests asked to sign in; customers kept out of admin and seller pages; 404 page; out-of-stock items | ✅ | ✅ | ✅ |
| `stripe` (`STRIPE=1`) | Real Stripe test checkout: card 4242 pays the order; card 4000 0000 0000 0002 shows the decline and stays unpaid | ✅ | – | – |
| `responsive` | 17 pages × phone (375 px), tablet (768 px), desktop (1440 px) × light and dark | ✅ | – | – |
| `a11y` | axe-core scan of 19 pages; keyboard-only sign in, search and product; focus stays inside dialogs | ✅ | – | – |

Every test also fails on any browser console error.

### Live services

| Check | Result |
|---|---|
| `redis:check` | ping 1 ms, locks, concurrent lock refused (409), rate-limit window, JSON cache |
| `es:check` | typo search, facets, sort, typeahead, "did you mean", live index up to date (184 products) |
| `s3:check` | upload, public URL serves it, delete, bucket contents not publicly listable |

---

## 2. Docker, fresh clone and production config

**Fresh clone:** the repository was cloned from GitHub into an empty folder and started using only the README's Docker
quick start (bundled MongoDB, test gateway, no accounts or keys). One command started all five containers, the demo
data seeded itself, and 12 / 12 browser flows passed against it.

| Image | Size | Checks |
|---|---|---|
| `api` (Node 24, production dependencies only) | 532 MB | runs as non-root `node`; healthcheck; no `.env`, secrets or dev tools in any layer |
| `web` (nginx + built app) | 76 MB | no source maps; security headers; nginx version hidden |

**Production guards** (`NODE_ENV=production`), each refused at startup with a clear message: weak `JWT_SECRET`, the
template's placeholder secret, missing Stripe keys without `ALLOW_TEST_GATEWAY`, `http://` Elasticsearch, missing
Redis, `AUTO_SEED=true`, and a deployed host without `NODE_ENV=production`. A valid configuration starts normally.

### Live deployment

The frontend and the API are deployed separately, as the brief asks:

| Part | Where | Address |
|---|---|---|
| Web app | Vercel (static build, global CDN) | https://nexvia-e-commerce.vercel.app |
| API | Render, Singapore, free plan (Node 24) | https://vendora-api-i3wm.onrender.com |
| Services | MongoDB Atlas, Upstash Redis (TLS), AWS S3 (ap-south-1), Stripe test mode | — |

Checked against the live addresses (read-only requests, plus one manual test order):

| Check | Result |
|---|---|
| API `/health` | database connected, cache `redis`, storage `s3`, payments `stripe`; search `mongodb` (Elasticsearch deliberately not hosted) |
| Data | 184 products and 5 stores served from Atlas |
| HTTPS | `http://` redirects to `https://`; HSTS on both sites |
| Security headers | CSP, `X-Frame-Options`, `nosniff`, referrer and permissions policy on the web app; helmet headers on the API |
| Web app | home and deep links (e.g. `/product/…`) load; `robots.txt` served; the build points at the live API |
| CORS | the Vercel site is allowed with credentials (login cookie across the two domains); any other origin is refused |
| Stripe webhook | an unsigned request is refused with `Invalid webhook signature`, so only Stripe's signed events are accepted |
| Speed | ~0.3 s for a 24-product list from India once awake; the free plan sleeps when idle (first request up to ~50 s) |
| End to end (manual) | signed in, checked out and paid with card 4242 → order *Placed*, payment *Paid* via Stripe (card), invoice downloaded; the order appears in the seller hub |

---

## 3. Performance

Measured with [`server/scripts/load-test.ts`](../server/scripts/load-test.ts) from **inside the Docker network**, straight
to the API container (one Node.js process, no clustering). From Windows every request carries ~15 ms of Docker Desktop
port-forwarding overhead, which is not the app.

### One request at a time (p50 / p95 ms)

| Endpoint | p50 | p95 |
|---|---|---|
| `GET /stores?q=tech` | 0.6 | 1.0 |
| `GET /health` | 0.8 | 2.2 |
| `GET /products/:id` | 1.2 | 1.6 |
| `GET /home` | 2.4 | 3.6 |
| `GET /orders` (signed in) | 4.2 | 6.8 |
| `GET /cart` (signed in) | 5.0 | 6.3 |
| `GET /products/suggest?q=lap` | 5.1 | 7.2 |
| `GET /products?q=phone` (search) | 5.2 | 6.3 |
| `GET /products` filters + sort | 5.5 | 7.8 |
| `GET /products` (list, 24 items) | 5.8 | 6.8 |
| `GET /products?q=iphnoe` (typo) | 5.8 | 6.6 |
| `GET /orders/:id/invoice` (PDF) | 9.3 | 11.2 |

### Under load (p95 ms · requests per second; 1,000 requests per cell, 0 errors)

| Endpoint | 10 users | 50 users | 100 users |
|---|---|---|---|
| Product page | 5.5 · 2,360 | 23.0 · 2,931 | 44.1 · 3,319 |
| Stores | 2.3 · 5,586 | 10.7 · 7,280 | 23.9 · 6,092 |
| Home | 24.6 · 934 | 48.1 · 1,517 | 80.9 · 1,660 |
| Search | 12.9 · 996 | 46.6 · 1,331 | 69.8 · 1,620 |
| Product list | 18.5 · 795 | 64.7 · 1,047 | 109.7 · 1,184 |
| Cart | 24.6 · 526 | 84.0 · 683 | 184.1 · 631 |
| Orders | 19.9 · 667 | 81.0 · 710 | 160.1 · 727 |
| Invoice PDF | 94.2 · 142 | 345.2 · 162 | 765.2 · 135 |

PDF generation is CPU-bound and the slowest; invoices are downloaded rarely.

### What Redis and Elasticsearch are worth (50 users, p50 ms)

| Endpoint | Normal | Redis stopped | Elasticsearch stopped |
|---|---|---|---|
| Home | 31 | **362** (12× slower) | – |
| Product page | 17 | 126 | – |
| Cart | 75 | 198 | – |
| Product list | 46 | 35 | **122** |
| Typo search `iphnoe` | 7 results | – | **0 results** |

No errors in any configuration: both services degrade gracefully.

### Lighthouse (performance / accessibility / best practices / SEO)

| Page | Desktop | Mobile (simulated slow 4G) |
|---|---|---|
| Home | 98 / 96 / 100 / 100 | 73 / 100 / 100 / 100 |
| Product | 97 / 100 / 100 / 100 | 71 / 100 / 100 / 100 |
| Search | 98 / 91 / 100 / 100 | 73 / 94 / 100 / 100 |
| Stores | 98 / 100 / 100 / 100 | 75 / 100 / 100 / 100 |

Measured after all fixes (before them: product desktop 81 / 87 / 100 / 92 with a layout shift of 0.29). Lighthouse's
remaining accessibility notes on search and home are rules beyond WCAG 2.1 A/AA (heading order, touch-target size)
and contrast caught mid-animation; the axe WCAG scan in section 1 finds no violations on any page.

### Frontend bundle

| File | Size | Gzipped |
|---|---|---|
| App code | 427 kB | 133 kB |
| Charts (Recharts, seller and admin dashboards only) | 395 kB | 109 kB |
| Animations (Framer Motion) | 141 kB | 47 kB |
| CSS (Tailwind) | 137 kB | 19 kB |

Pages are split into chunks loaded on demand, so shoppers never download the charts.

---

## 4. Found and fixed during the audit

| # | Severity | Problem | Fix |
|---|---|---|---|
| 1 | High | After an admin **search reindex**, store search returned nothing (the cleanup deleted the store index too) | Cleanup only deletes old product builds (`search.ts`) |
| 2 | Medium | Admin store search couldn't find a store by the seller's phone or GSTIN | Indexed for admins only; shoppers still can't search them |
| 3 | Medium | The seller hub said payouts are "released" on delivery; they are held through the return window | Toast, page text and dashboard card corrected |
| 4 | Medium | Product page layout shift (CLS 0.29, "poor") | Page loader is a full screen tall → CLS 0, desktop performance 81 → 97 |
| 5 | Medium | Checkout and seller dashboard wider than a phone screen | Grid columns allowed to shrink |
| 6 | Medium | Product cards' quick-add button invisible on touch tablets (hover only) | Hidden-until-hover only with a mouse; also shown on keyboard focus |
| 7 | Medium | Form labels not linked to their inputs; 9 dropdowns without a name | Shared `Field` links label, hint and error to its control; names added |
| 8 | Medium | No focus trap in dialogs; payment popup and cart drawer not marked as dialogs | `useFocusTrap` in every dialog and drawer, roles and names added |
| 9 | Low | Missing web security headers, nginx version shown; foreign CORS origin answered 500 | Headers on nginx and Vercel, `server_tokens off`, quiet CORS refusal |
| 10 | Low | `robots.txt` missing (SEO 92) | Added → SEO 100 |
| 11 | Low | Gallery buttons without names, star rating ARIA misuse, low-contrast tabs, invisible focus ring on coloured buttons | Fixed |
| 12 | Low | "1 items", "1 units"; coupons already used still suggested | `plural()` helper; used-up coupons hidden for signed-in shoppers |
| 13 | Docs | README Docker steps failed without Stripe keys; a non-existent "one-click demo login" was described | Docker quick start rewritten and verified on a fresh clone |

---

## Known limitations

### Dependency audit (`pnpm audit`, 19 November 2026)

The client has no known vulnerabilities. The server has two, both left as they are on purpose:

| Package | Severity | Issue | Why it stays for now |
|---|---|---|---|
| `zod` 3.25.x | High ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)) | Validating an oversized constrained collection can use up memory | Fixed only in zod 4.6.6+, a major version with breaking API changes to every validation schema. The API's 1 MB request body limit caps the input, and a 50,000-item array is rejected in well under 3 seconds (security suite). Planned: upgrade to zod 4 after submission. |
| `minimatch` 10.2.x (via `nodemon`) | Moderate | Denial of service through glob pattern amplification | Development-only dependency (`nodemon` file watcher); never installed in the production image. |

### Other open items

- **Mobile first paint** is ~3.5 s on Lighthouse's simulated slow 4G (fonts and CSS block rendering, the home headline
  fades in, ~180 kB of unused JavaScript). Desktop is fast; improving mobile is planned.
- **Stripe Connect payouts** are covered by unit tests (transfer, reversal, never paying twice) but a real payout to a
  test seller was not run end to end, because it needs Stripe's hosted onboarding.
- **TypeScript** runs with `strict: false`: every file is type-checked, but loosely.

---

## How to repeat

```bash
pnpm --dir server typecheck && pnpm --dir client typecheck && pnpm --dir client build
pnpm --dir server test                                   # unit tests, no services needed
pnpm --dir server redis:check; pnpm --dir server es:check; pnpm --dir server s3:check   # live services from server/.env
```

The suites below **change data**: run them only against a throwaway stack with the demo seed (for example the Docker
quick start in the README with `--profile local-db`), never against Atlas. They need an admin account in that
database (`AUDIT_ADMIN_EMAIL` / `AUDIT_ADMIN_PASSWORD`; register one and set its `role` to `admin`).

```bash
# API integration and security (BASE_URL = web port; API_DIRECT_URL optional, needs the API port published)
BASE_URL=http://localhost:8080 AUDIT_ADMIN_EMAIL=... AUDIT_ADMIN_PASSWORD=... pnpm --dir server test:integration
BASE_URL=http://localhost:8080 AUDIT_ADMIN_EMAIL=... AUDIT_ADMIN_PASSWORD=... pnpm --dir server test:security   # last test locks logins for 15 min

# Browser tests (first time: pnpm --dir e2e install && pnpm --dir e2e exec playwright install)
BASE_URL=http://localhost:8080 ADMIN_EMAIL=... ADMIN_PASSWORD=... pnpm --dir e2e test
STRIPE=1 pnpm --dir e2e exec playwright test tests/stripe.spec.ts   # with Stripe test keys configured

# Load test, from inside the Docker network
docker run --rm --network <project>_default -v "$PWD/server/scripts:/s:ro" -e API_URL=http://api:5050 node:24-alpine node /s/load-test.ts
```

The manual Postman plan for every endpoint is in [API_TESTS.md](API_TESTS.md).
