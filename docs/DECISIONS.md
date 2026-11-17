# Vendora: design decisions

The main technical choices, why they were made, and what they cost. Each entry: **context → decision → why →
trade-off**. Newest choices are near the end.

---

## 1. MongoDB (Mongoose) instead of PostgreSQL + Prisma

**Context.** The brief's tool list names PostgreSQL and Prisma; its milestones (catalogue, cart, orders, payments,
reviews) don't depend on a particular database. The project was started on MongoDB Atlas with Mongoose.

**Decision.** Keep MongoDB.

**Why.**
- **The data is document-shaped.** An order holds one package per seller, each with its items, timeline, refund and
  payout. In MongoDB that is one document, read and updated in one go. In PostgreSQL it is 5–6 joined tables.
- **Transactions are available.** Atlas runs as a replica set, so checkout and payment finalisation run in
  multi-document transactions (stock, coupon use, order status together). Atomic single-document updates handle the
  rest: stock is decremented with a conditional `$inc`, so stock never goes negative.
- **Change streams** power live updates (cart prices, product and coupon changes pushed to the browser) and keep the
  Elasticsearch index in sync without extra infrastructure.
- **Deadline risk.** Moving every model, query and transaction to Prisma near the deadline would have meant retesting
  payments, refunds and payouts from scratch, for no gain in features.

**Trade-off.** No foreign keys: consistency between collections is enforced in code (validation, transactions,
reconciliation job). Ad-hoc reporting is less convenient than SQL; analytics use aggregation pipelines instead.

---

## 2. Stripe instead of Razorpay

**Context.** The brief allows Razorpay or Stripe Connect test mode. Razorpay was used first.

**Decision.** Stripe: Payment Element for checkout, Connect **Express** accounts for sellers.

**Why.** Stripe's test mode covers the whole marketplace flow without business verification: card payments
(including 3-D Secure), refunds, webhooks, seller onboarding and transfers. Its webhook and idempotency tooling made
the payment code safer to build.

**Trade-off.** Stripe is invite-only for new Indian businesses, so a real launch in India would need Razorpay Route or
an Indian Stripe account. Charging in INR works in test mode on any account. Transfers to sellers need a currency
the platform account supports (`STRIPE_CURRENCY`).

---

## 3. Separate charges and transfers, paid out after the return window

**Decision.** The customer pays the platform once for the whole cart. Each seller's share (package total minus
commission, default 10%) is transferred to their Connect account **7 days after delivery** (`RETURN_WINDOW_DAYS`) by an
hourly job.

**Why.** One cart can hold several sellers, which a single destination charge can't split. Holding the money until
returns close means a refunded return never has to claw money back from a seller.

**Trade-off.** Sellers wait longer to be paid. The platform needs a reconciliation job (every 6 hours and on demand)
to compare Stripe with the database and repair what is safe.

**Related rules.** A seller bears its own coupon discounts. Coupon uses are not given back after a paid order is
cancelled or refunded. Payout destination changes need the seller's password and can freeze payouts until an admin
confirms (`payoutHold`).

---

## 4. Payment safety: idempotency, webhooks and no-money test gateway

**Decision.** Every payment attempt is a Payment record; every refund is written to the database **before** Stripe is
called, with an idempotency key per attempt. Webhook events are stored and processed once. The built-in test gateway
(which marks orders paid without money) only runs with an explicit `ALLOW_TEST_GATEWAY=true`.

**Why.** Network failures and retries must never charge or refund twice, and a deployed API with missing Stripe keys
must refuse to start rather than silently accept unpaid orders.

**Trade-off.** More records and states to manage (`pending`, `processing`, `failed`, retry), covered by unit tests.

---

## 5. Short access token + rotating refresh token

**Decision.** A 15-minute JWT access token kept in memory only, plus a refresh token in an httpOnly cookie (path
`/auth`) that rotates on every use. Sessions are stored server-side (only a SHA-256 of the secret), so they can be
listed and revoked per device. Refresh calls require an `X-Requested-With` header.

**Why.** An injected script can't read a long-lived credential, and blocking a user or changing a password ends every
session at once. A replayed old refresh token is detected (with a short grace period for parallel tabs).

**Trade-off.** More moving parts than one long-lived JWT. Each request checks the session, which is cached in Redis
to stay fast.

**Not included, by choice:** email verification and OTP. Sign-up is plain email + password.

---

## 6. Redis for sessions, locks, rate limits and caches

**Decision.** Redis holds the session cache, distributed locks (checkout, package updates, refunds), rate-limit
counters and page/cart caches. In development an in-memory store with the same API replaces it. Production refuses
to start without Redis unless explicitly allowed.

**Why.** Locks and rate limits must hold across every API instance. The in-memory fallback lets the project run with
zero setup.

**Trade-off.** One more service to run in production. Everything in Redis expires on its own, so it needs no backups.

---

## 7. Elasticsearch with a MongoDB fallback

**Decision.** Product search, facets and typeahead run on Elasticsearch (typo tolerance, synonyms, partial matches),
and so do store, user and admin order search. If Elasticsearch is down, search switches to an equivalent MongoDB
query and switches back on its own (checked every 15 s). The index is versioned behind an alias, so it rebuilds
without downtime.

**Why.** Search quality is a core marketplace feature, but an outage of the search cluster shouldn't take the shop
down. Measured in [TEST_RESULTS.md](TEST_RESULTS.md): the fallback is as fast, but returns nothing for typos.

**Trade-off.** Two search implementations to keep consistent (both are covered by tests).

---

## 8. Ids in URLs, no slugs

**Decision.** URLs use ids (`/product/:productId`, `/store/:storeId`).

**Why.** Renaming a product or store never breaks a link, and there is no slug uniqueness to maintain.

**Trade-off.** Less readable URLs and weaker SEO than `/product/iphone-13-pro`.

---

## 9. Only customers buy

**Decision.** Cart and checkout are customer-only on the server (403 for others), and the UI hides every buying control
from sellers and admins.

**Why.** It keeps the money flow simple (no seller buying from itself to fake sales or reviews) and keeps roles clear.

---

## 10. No seeded admin

**Decision.** The seed creates customers and stores but never an admin; existing admins are kept on every reseed.

**Why.** A known demo admin password is a real risk if the database is ever exposed. The platform owner promotes their
own account instead.

---

## 11. Production safety checks at startup

**Decision.** With `NODE_ENV=production` the API refuses to start on a weak `JWT_SECRET`, a plain `http://`
Elasticsearch URL, missing Redis or Stripe keys, or `AUTO_SEED=true`. Demo seeding and database wipes are blocked in
production.

**Why.** Most real incidents come from misconfiguration, not code. Failing at startup is far better than running
insecurely.

---

## 12. Docker: one origin through nginx

**Decision.** `docker compose` runs the API, the web app, Redis and Elasticsearch. The web image is the built React
app on nginx, which forwards API paths to the API container. A page load of a path that is also an API prefix
(`/cart`, `/orders`) gets the app. The live cart stream is not buffered.

**Why.** The browser talks to a single origin, exactly like the Vite dev proxy, so there is no CORS setup and the
refresh cookie stays first-party. Because one URL (e.g. `/orders/:id`) can answer HTML or JSON, responses carry
`Vary: Accept` and the app shell is `no-cache`; without that, the browser reused the cached page HTML for the API call
and the order page rendered blank (found while taking the screenshots, fixed in `client/nginx.conf`). Redis and Elasticsearch are only reachable from the host itself.

**Trade-off.** In the split deployment (Render + Vercel) the API is on another domain, which needs CORS and
`SameSite=None; Secure` cookies; both setups are supported.

---

## 13. TypeScript: run directly on Node, `strict` off for now

**Decision.** Both apps are TypeScript. The client is compiled by Vite, and `tsc` type-checks before each build. The
API's `.ts` files run directly on Node 24 (type stripping): no build step, no `dist/` folder. `tsc` only type-checks.
Only syntax Node can strip is allowed (`erasableSyntaxOnly`: no enums or parameter properties), and imports use
`.ts` extensions.

**Why.** The conversion couldn't change runtime behaviour this close to the deadline. With type stripping the code
that runs is the code in the repo, and the client's production bundle came out byte-for-byte the same as before. The
~1,900 errors that `strict` mode reports on the converted code (1,283 server, 623 client, measured) would have taken days; loose mode reached 0 errors with real types where
they matter most: API objects, stores, shared UI components, Express `req`, model methods and the Redis client.

**Trade-off.** Some values are still typed `any` (mainly Mongo filters and populated documents). Turning on `strict`
is the next step.

---

## 14. Separate frontend and backend deploys

**Decision.** The API deploys to Render (`render.yaml`, Node 24) and the React app to Vercel (`client/vercel.json`),
as the brief asks. The same code also runs as containers (`server/Dockerfile`, `client/Dockerfile`).

**Why.** Each side scales and deploys on its own, and a frontend change never restarts the API. S3 holds uploads, so
the API host's disk can be wiped on every deploy.

---

## Next steps

- Turn on TypeScript `strict` file by file, starting with services.
- Fix the 3 startup tests (use an `https://` Elasticsearch URL in their setup).
- CI pipeline: tests, type checks and the client build on every push.
- Load tests against Atlas, Elastic Cloud and Upstash rather than local containers.
- Razorpay Route as a second payment provider for an India launch.
