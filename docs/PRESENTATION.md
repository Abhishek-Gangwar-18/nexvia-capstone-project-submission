# Vendora: final presentation outline (10 minutes)

Slide-by-slide plan for the final presentation: what each slide shows, what to say, and timing. It covers what the
brief asks for: **problem, design, challenges, results and next steps**. Numbers come from
[TEST_RESULTS.md](TEST_RESULTS.md), and the reasoning behind choices from [DECISIONS.md](DECISIONS.md).

| # | Slide | Time |
|---|---|---|
| 1 | Title | 0:20 |
| 2 | The problem | 0:50 |
| 3 | What Vendora does | 0:50 |
| 4 | Architecture | 1:10 |
| 5 | How the money moves | 1:00 |
| 6 | Live demo | 2:30 |
| 7 | Challenges and how I solved them | 1:20 |
| 8 | Results: tests and performance | 1:00 |
| 9 | What I'd do next | 0:30 |
| 10 | Thank you / questions | 0:20 |
| | **Total** | **10:00** |

---

## 1. Title (0:20)

**Vendora: a multi-vendor e-commerce marketplace.** Your name, Nexvia Tech, Full-Stack Development track, 20 Oct –
20 Nov 2026.

## 2. The problem (0:50)

- An Amazon-style marketplace: many sellers, one shop, one checkout.
- The hard parts aren't the pages. They are:
  - splitting **one payment** between several sellers and the platform's commission;
  - keeping **stock correct** when many people buy at once;
  - **refunds, returns and payouts** that never pay twice or lose money;
  - **search** that still finds "iphnoe".

## 3. What Vendora does (0:50)

Three roles, one screenshot each:
- **Customer:** search, cart, multi-seller checkout with Stripe, order tracking, returns, reviews, PDF invoices.
- **Seller:** onboarding, products with S3 image upload, fulfilment, returns, payouts via Stripe Connect, dashboard.
- **Admin:** seller approvals, analytics, order management, moderation, coupons, commission settings, system health.

## 4. Architecture (1:10)

Show the system diagram (`docs/diagrams/system-overview.mmd`) and the containers diagram.

- **Frontend:** React 19 + TypeScript, Vite, Tailwind, TanStack Query.
- **Backend:** Node 24 + Express + TypeScript, 114 API routes.
- **Data:** MongoDB Atlas (transactions, change streams), Redis (sessions, locks, rate limits, cache),
  Elasticsearch (search), AWS S3 (images), Stripe (payments + Connect).
- **Runs anywhere:** `docker compose up` starts the whole stack. Deployed as separate frontend (Vercel) and backend
  (Render).
- Point to make: **every external service has a fallback**, so search keeps working when Elasticsearch is down.

## 5. How the money moves (1:00)

Show the payment flow diagram.
- Customer pays once → platform keeps the commission (10% default) → each seller's share is transferred to their
  Stripe Connect account **7 days after delivery**, once returns are closed.
- Every refund is recorded **before** calling Stripe, with an idempotency key, so a retry can never refund twice.
- A reconciliation job compares Stripe with the database every 6 hours.

## 6. Live demo (2:30)

Practise this path; have it open in tabs before you start. Use card `4242 4242 4242 4242`.

1. **Search** "iphnoe" → typo corrected, results appear (Elasticsearch). *(20 s)*
2. **Add two products from two different stores** → cart shows two packages. *(20 s)*
3. **Checkout and pay** with the Stripe test card → order placed. *(40 s)*
4. **Seller view (TechNova):** order appears → mark *packed* → *shipped*. *(30 s)*
5. **Customer view:** timeline updates; download the **PDF invoice**. *(20 s)*
6. **Admin:** analytics dashboard with GMV and commission. *(20 s)*

**Backup:** record the demo as a video beforehand in case the network or a service fails during the talk.

## 7. Challenges and how I solved them (1:20)

Pick three:
- **Overselling under load:** stock is reserved with an atomic conditional update and held for 15 minutes during
  payment; unpaid orders release it automatically.
- **Paying twice:** idempotency keys, webhook de-duplication, and refunds written before the Stripe call.
- **Services going down:** Redis and Elasticsearch failures switch to fallbacks and switch back on their own.
- **Late stack changes:** moved from Razorpay to Stripe, then added Docker and converted 161 files to TypeScript
  without changing runtime behaviour (the client's production bundle came out identical).
- **A hidden deploy bug:** a file-name case mismatch (`address.js` vs `Address.js`) that works on Windows but crashes on
  Linux; found and fixed during the TypeScript migration.

## 8. Results: tests and performance (1:00)

- **Tests:** 133 / 133 unit tests, 232 / 232 API integration checks, 24 / 24 security checks, and 14 browser flows
  passing in Chrome, Firefox and Safari's engine (plus real Stripe test-card payments).
- **Quality:** 0 TypeScript errors; every page fits phone, tablet and desktop; 19 / 19 pages pass an automated
  WCAG 2.1 AA accessibility scan; Lighthouse desktop performance 97–98, SEO 100.
- **Latency:** every read endpoint under 8 ms p95 for a single request; invoice PDF 11 ms.
- **Load:** 100 concurrent users, ~40,000 requests, **0 errors**; product pages at 3,300 requests/second.
- **Resilience:** Redis, Elasticsearch or MongoDB can go down without a crash; Redis makes the home page 12× faster.
- **Audit:** a pre-submission audit found and fixed 13 issues, the biggest being store search breaking after a
  reindex (details in TEST_RESULTS.md).

## 9. What I'd do next (0:30)

- TypeScript `strict` mode.
- CI pipeline: tests, type checks and build on every push.
- Load test against the hosted services (Atlas, Elastic Cloud, Upstash).
- Razorpay as a second payment provider for an Indian launch.

## 10. Thank you / questions (0:20)

Repo link, live demo link, and your contact.

---

## Likely questions

| Question | Short answer |
|---|---|
| Why MongoDB, not PostgreSQL + Prisma? | Orders are document-shaped (packages, items, timeline in one record); Atlas gives transactions and change streams. See DECISIONS.md §1 |
| Why pay sellers after 7 days? | So a refunded return never has to claw money back from a seller |
| What if Stripe's webhook never arrives? | Reconciliation job every 6 hours, plus the client confirms the payment on return |
| How do you stop two buyers taking the last item? | Atomic conditional stock decrement; the second checkout gets a clear "out of stock" error |
| Why is `strict` TypeScript off? | Turning it on reports ~1,900 errors; done safely it's a multi-day job, planned next |
| How is the API secured? | Short-lived tokens, rotating refresh cookie, server-side sessions, rate limits, role checks on every route, startup refuses unsafe production config |
