# Vendora: multi-vendor e-commerce marketplace

An Amazon-style marketplace where many sellers list products, customers buy from several stores in one checkout, and
the platform splits each payment between the sellers and its own commission.

**Stack:** React 19 (Vite, Tailwind CSS v4, Framer Motion, TanStack Query, Zustand, Recharts) · Node.js + Express ·
MongoDB (Mongoose) · Elasticsearch 8 · Redis · AWS S3 · Stripe (Payment Element + Connect)

> The architecture, database schema, concurrency rules, auth flow, order lifecycle, payment split and full API list are in
> **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. A step-by-step Postman/curl test plan for every endpoint is in
> **[docs/API_TESTS.md](docs/API_TESTS.md)**.

---

## Features

**Customers**
- Storefront with an animated hero, categories, deals of the day with a live countdown, trending products, top stores and recently viewed items
- Search on Elasticsearch: typo tolerance, Indian shopping synonyms (phone/mobile, tv/television, ...), typeahead with **"Did you mean?"** spelling corrections, faceted filters (category, brand, price slider, rating, in stock), six sort orders (popularity by default: best matches first when searching), shareable URLs
- Product page with a zoomable gallery, a share pop-up (copy link, WhatsApp, Telegram, X, email), seller card, specs, star ratings (one per customer) and reviews with photos, helpful votes and seller replies; both need a delivered order
- Cart for signed-in customers (cached in Redis), price-rise/drop and low-stock notices, free-shipping meter, coupons, save for later
- **Live cart:** stock, price, availability and coupon changes reach an open cart, product page and checkout within a second (MongoDB change streams + Server-Sent Events), with no reload. Checkout refuses a total, stock or product that changed since the customer saw it (`409 CART_CHANGED`)
- Only customers can buy: sellers and admins see no cart or buy buttons (a seller gets *Edit product* on their own listings, an admin *Moderate*)
- Two-step checkout with address book, per-seller package preview, stock held for 15 minutes while paying, and the Stripe Payment Element (or the built-in test gateway)
- Order tracking timeline for each package, PDF invoices, cancel and refund, retry payment
- Returns within the return window (pick items and quantities, reason, up to 5 photos) and a **Refunds** card on the order page showing each refund and its status
- Wishlist, profile with avatar upload, password change, signed-in devices with log out everywhere, dark mode. Sign-up is plain email + password

**Sellers**
- Four-step onboarding (store, business, bank details), admin approval and a live store page; Stripe Connect for automatic payouts
- Dashboard with KPIs vs the previous period, a sales chart, payouts on hold and released, top products and low-stock alerts
- Product editor with drag-and-drop S3 uploads (reorder, pick cover), tags, specs, an earnings estimate and live preview. Saves send only changed fields and are refused (409) if sales moved the stock or someone else saved the product meanwhile
- Store settings with a live preview of the store card as shoppers see it
- Fulfilment: packed, then shipped (tracking id), then delivered, which releases the payout; or cancel with a reason, which restocks, refunds and reverses the payout
- Returns manager: approve or reject requests, mark items received (restock optional), which refunds the customer automatically
- Payouts page with Stripe Connect onboarding and a payout ledger; review replies, store coupons, store settings

**Admin**
- Analytics (7D, 30D, 90D, 1Y): GMV, commission revenue, orders, AOV with change, revenue trend, package fulfilment, sales by category, top sellers and products
- Seller approvals (approve, reject or suspend with a reason), per-seller commission override, payout holds after a payout account change. Suspending a store (or blocking its owner) with paid, unshipped orders asks whether to cancel and refund them or keep them
- Order management: KPI cards, server-side search and filters (status, payment, package, refund, vendor, amount, date range), a *Needs attention* view (failed refunds, payment mismatches, stock issues, late dispatch or delivery, missing tracking), CSV export, and package controls; returns, a payments panel (refunds, payouts on hold, release due payouts), category management, product and review moderation, user blocking (ends their sessions at once; a blocked user sees only a "not allowed" screen and the API refuses their browser, public pages included), platform coupons
- Settings (commission, shipping rules) with a change history, a live **system status** panel and an Elasticsearch reindex button

---

## Run it locally

**Requirements:** Node.js 18.18 or newer (tested on Node 24) and a MongoDB database (a free MongoDB Atlas cluster,
or `docker compose up -d`). Redis, Elasticsearch and S3 can use local fallbacks. To simulate payments locally,
explicitly set `ALLOW_TEST_GATEWAY=true` in `server/.env`.

```bash
pnpm --dir server install; pnpm --dir client install   # install dependencies
cp server/.env.example server/.env                      # then set MONGO_URI

# then, each in its own terminal:
pnpm --dir server dev    # API on http://localhost:5050
pnpm --dir client dev    # web app on http://localhost:5180
```

Open **http://localhost:5180**.

- **Empty database:** the API seeds demo data automatically: 20 customers, 5 stores, 184 products from DummyJSON,
  about 1,180 ratings and reviews, 210 historical orders and coupons. Run `pnpm --dir server seed` to reset to that data at any time.
  `pnpm --dir server seed:fresh --yes` wipes the database, the app's S3 images and Redis and reseeds with every image
  uploaded to S3 (stop the API first). Demo seeding and resets are development-only.
- **Tests:** `pnpm --dir server test` runs the API unit tests (no database or services needed).
- **Live service checks:** `pnpm --dir server redis:check`, `s3:check` and `es:check` test the real Redis, S3 bucket and
  Elasticsearch from `server/.env`. Each touches only its own service (temporary keys, one test image, a temporary
  index), never MongoDB.

### Seeded accounts

**No admin account is seeded.** The platform owner is the only admin; existing admin accounts are kept every time
`pnpm --dir server seed` runs. To make your own account an admin, register it and then change its `role` field to `"admin"` in
the `users` collection.

| Store (seller) | Seller login | Categories |
|---|---|---|
| TechNova Electronics | `technova@vendora.dev` | Smartphones, laptops, tablets, mobile accessories |
| Urban Threads | `urbanthreads@vendora.dev` | Clothing, footwear, bags |
| Glow & Co. | `glow@vendora.dev` | Beauty, fragrances, skin care, watches, jewellery, sunglasses |
| Casa Living | `casa@vendora.dev` | Furniture, home decor, kitchen |
| FreshCart Daily | `freshcart@vendora.dev` | Groceries, sports & fitness |

All 5 sellers use the password `Vendor@123`. There are 20 customers, all with the password `Customer@123`: the demo
customer `customer@vendora.dev` (who has orders, a cart and a wishlist) plus 19 others such as
`ananya.gupta@example.com`. The login page has one-click buttons for the demo customer and the TechNova seller.

**Test coupons:** `WELCOME10`, `FLAT250`, `FESTIVE20`, `TECHNOVA5` (TechNova only), `GLOW15` (Glow & Co. only),
`MONSOON30` (expired).

---

## Switching on the real services

Edit `server/.env` (copy it from `server/.env.example`) and restart the API. The startup log and
**Admin → Settings & system** show which service is live.

| Service | Variables | Notes |
|---|---|---|
| **MongoDB Atlas** | `MONGO_URI=mongodb+srv://<user>:<pass>@<cluster>/vendora?retryWrites=true&w=majority` | Add your IP under Atlas → Network Access. An empty database is seeded on first start, and payments are finalized in multi-document transactions (Atlas is a replica set). If Node can't resolve the SRV record (`querySrv ECONNREFUSED` on some Windows setups), the API retries via public DNS automatically |
| **Redis** | Local: `docker compose up -d redis`, then `REDIS_URL=redis://localhost:6379`. Production: a hosted Redis (Upstash `rediss://...` or Render Key Value) | Sessions, locks (packages, refunds, checkout), login/refresh/password rate limits, cart and page cache. Run `pnpm --dir server redis:check` to test the connection. Required in production |
| **Elasticsearch** | `ELASTICSEARCH_NODE=http://localhost:9200` (+ `ELASTICSEARCH_API_KEY` for Elastic Cloud) | Product search, facets and typeahead with typo tolerance and synonyms, plus typo-tolerant search for stores, users, admin orders and the seller/admin product lists. The index is built from MongoDB on startup, rebuilt without downtime, and search falls back to MongoDB during an outage. Run `pnpm --dir server es:check` to test it |
| **AWS S3** | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` | Image uploads. The bucket needs public read for `products/*`, `stores/*`, `avatars/*`, `reviews/*` and `returns/*` (or a CloudFront URL in `AWS_S3_PUBLIC_URL`); the IAM key only needs `s3:PutObject` and `s3:DeleteObject`. Run `pnpm --dir server s3:check` to test the bucket |
| **Stripe** | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` (test keys) | The Stripe Payment Element replaces the test gateway; see *Stripe setup* below |

If you have Docker, `docker compose up -d redis elasticsearch` starts Redis 7 and Elasticsearch 8.19 (both bound to localhost, restarting with Docker Desktop); plain `docker compose up -d` also starts MongoDB 7.

### Stripe setup (payments, refunds, vendor payouts)

1. **Account:** sign up at <https://dashboard.stripe.com/register> and switch on **Test mode** (top right). Test mode
   works before the account is activated. Stripe is invite-only for new businesses in India, so you may need another
   country for the account (see *Currency* below).
2. **API keys:** Developers → API keys. Copy the **Publishable key** (`pk_test_…`) to `STRIPE_PUBLISHABLE_KEY` and the
   **Secret key** (`sk_test_…`) to `STRIPE_SECRET_KEY` in `server/.env`. The client needs no key of its own: the API
   sends the publishable key with each payment.
3. **Connect (vendor payouts):** Connect → Get started → choose a *marketplace* with **Express** accounts, then fill in
   Connect settings → Branding (name, icon, colour; Express onboarding needs them). Optional: `STRIPE_CONNECT_COUNTRY`
   (e.g. `IN`, `US`) for vendor accounts; empty uses your account's country.
4. **Webhooks, local:** install the Stripe CLI (Windows: `scoop install stripe`, or the zip from
   <https://github.com/stripe/stripe-cli/releases>), then:
   ```bash
   stripe login
   stripe listen --forward-to localhost:5050/payments/webhook --forward-connect-to localhost:5050/payments/webhook
   ```
   It prints a signing secret `whsec_…`: put it in `STRIPE_WEBHOOK_SECRET` and keep the command running.
5. **Webhooks, deployed:** Developers → Webhooks → Add endpoint `https://<your-api>/payments/webhook`:
   - *Events on your account*: `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`,
     `payment_intent.canceled`, `refund.created`, `refund.updated`, `refund.failed`, `charge.refund.updated`
     → its signing secret goes in `STRIPE_WEBHOOK_SECRET`.
   - A second endpoint (same URL) for *Events on connected accounts*: `account.updated`,
     `account.external_account.created`, `account.external_account.updated`, `account.external_account.deleted`
     → `STRIPE_CONNECT_WEBHOOK_SECRET`.
6. **Restart the API.** The log says `Payments: Stripe TEST mode`, and Admin → Settings & system shows Stripe as live.
7. **Pay:** card `4242 4242 4242 4242`, any future date, any CVC. 3-D Secure: `4000 0025 0000 3155`. Declined:
   `4000 0000 0000 0002`.
8. **Vendor payouts:** as a seller open **Payouts → Connect Stripe** and finish Stripe's test onboarding (it offers test
   data). Vendors are paid `RETURN_WINDOW_DAYS` (default 7) after delivery; set `RETURN_WINDOW_DAYS=0` while testing,
   then use Admin → Payments → *Release due payouts*.

**Currency:** prices are charged in `STRIPE_CURRENCY` (default `inr`). Charging INR works on any test account, but a
transfer to a vendor must be possible in that currency for your account's country. With a non-Indian test account,
set `STRIPE_CURRENCY` to your account's currency (e.g. `usd`) to try the full Connect flow; amounts are then charged
as the same numbers in that currency (test money only). If a transfer fails, the payout stays on hold with Stripe's
error and shows in Admin → Payments.

---

## Deploying (frontend and backend separately)

**Backend → Render** (`render.yaml` included) or any Node host
- Root directory: `server`, build command `pnpm install --prod --frozen-lockfile`, start command `pnpm start`, health check `/health`
- Environment: `NODE_ENV=production`, `MONGO_URI` (Atlas), `JWT_SECRET`, `CLIENT_URL=https://<your-vercel-app>`,
  `SERVER_URL=https://<your-api>`, plus Redis (Upstash), Elasticsearch (Elastic Cloud), S3 and Stripe keys.
  In production the refresh cookie defaults to `SameSite=None; Secure`, which an API on a separate domain needs (HTTPS only).
  Use S3 in production, because the host's local disk is wiped on every deploy.
  Deployed environments must set `NODE_ENV=production` and a random `JWT_SECRET` of at least 32 bytes. The API
  refuses to start without Stripe keys, because the test gateway marks orders paid without money. For an
  intentional demo without real payments, set `ALLOW_TEST_GATEWAY=true`. If Elasticsearch is configured, use an
  HTTPS endpoint and API key or username/password, and keep the cluster on a private network.

**Frontend → Vercel** (`client/vercel.json` included) or Netlify
- Root directory: `client`, build `pnpm build`, output `dist`
- Environment: `VITE_API_URL=https://<your-api>` (the API's origin, no `/api` suffix)

**Security checklist before going live**
- Atlas → Network Access: allow only the API host's outbound IPs, not `0.0.0.0/0`.
- Elasticsearch must require authentication (Elastic Cloud API key) and must not be reachable from the internet:
  the store and user indices hold emails and phone numbers.
- Stripe webhook URL: `https://<your-api>/payments/webhook` (no `/api`).
- MongoDB must be a replica set (Atlas is) for transactions and live cart updates.

---

## Project structure

```
├── client/                  React SPA (Vite)
│   └── src/
│       ├── components/      layout (search bar), product (share pop-up, seller/admin actions), cart, checkout, orders (returns,
│       │                    refunds), dashboard, account, admin (open-orders dialog), vendor (store preview), ui
│       ├── pages/           storefront, account, orders, vendor/* (incl. returns, payouts), admin/* (incl. payments, returns), auth/*
│       ├── lib/             api client, session, cart hooks + live cart updates (SSE), roles (who may buy), wheel scrolling,
│       │                    formatting, Stripe loader
│       └── store/           Zustand stores (auth profile, theme)
├── server/                  Express API
│   ├── src/
│   │   ├── config/          env, MongoDB connection
│   │   ├── models/          User, Session, Address, Vendor, Product, Category, Rating, Review, ReviewVote,
│   │   │                    Coupon, CouponRedemption, Cart, Order, Payment, Refund, Return, WebhookEvent, Settings
│   │   ├── services/        cache (Redis), locks, rateLimitStore, search (Elasticsearch), storage (S3),
│   │   │                    payment + webhooks + reconcile (Stripe), refunds, returns, payouts, orders, adminOrders,
│   │   │                    cart, pricing, coupons, reviews, invoice (PDFKit), session, catalog,
│   │   │                    productEvents (change streams for live cart, product and coupon updates)
│   │   ├── controllers/     auth, catalog, review, cart, order, return, payout, vendor, coupon, category, admin
│   │   ├── routes/          route definitions with zod validation + RBAC middleware
│   │   ├── middleware/      auth/RBAC, validation, uploads, errors
│   │   └── seed/            seed script + DummyJSON snapshot
│   ├── scripts/             redis-check, s3-check, es-check (live service checks)
│   └── test/                node:test unit tests
├── docs/ARCHITECTURE.md     roles, schema, concurrency, auth, lifecycle, payments, cache, search, API list
├── docs/API_TESTS.md        Postman/curl test plan for every endpoint
├── docker-compose.yml       local Redis / Elasticsearch (and optional MongoDB)
└── render.yaml              backend deploy blueprint
```

## Troubleshooting

- **`EADDRINUSE` / port 5050 is busy:** another `pnpm --dir server dev` is usually still running in another terminal: stop
  it with Ctrl+C (find it with `Get-NetTCPConnection -LocalPort 5050 -State Listen`). Otherwise change `PORT` and
  `SERVER_URL` in `server/.env`, and the proxy target in `client/vite.config.js`.
- **Uploaded image shows `AccessDenied`:** the S3 bucket policy is missing that folder (`products/*`, `stores/*`,
  `avatars/*`, `reviews/*`, `returns/*`). Check with `pnpm --dir server s3:check`.
- **Search runs on MongoDB** (`/health` or Admin → Settings & system shows `mongodb`): Elasticsearch isn't reachable
  (`docker ps`; it needs ~30 s to boot). The API retries every 15 s and switches back on its own, rebuilding the index first.
- **Open carts don't update live:** the API log says `Live cart updates: off`. Change streams need a replica set: Atlas
  (or a local replica set) works, a standalone MongoDB doesn't. Carts then refresh on open and on window focus only.
- **`.env` changes ignored:** `pnpm dev` only restarts on code changes; restart the API after editing `server/.env`.
- **"Cannot reach the server":** make sure the terminal running `pnpm --dir server dev` says `Vendora API ready`.
- **Signed out after updating:** sessions now use refresh tokens; sign in again once.
- **Stale pages after `pnpm --dir server seed`:** restart the API so the in-memory cache is cleared. With Redis, the seed script clears it for you.
- **"The service is temporarily unavailable" / `503 DB_UNAVAILABLE`:** the API can't reach MongoDB. The log shows
  `MongoDB connection lost` and, once it is back, `MongoDB connection restored`; the driver reconnects on its own.
  With Atlas this is almost always the network: Wi-Fi packet loss (run `ping 8.8.8.8 -n 20`), a VPN or antivirus
  "web shield", or a new public IP missing from Atlas → Network Access. A local MongoDB (`docker-compose.yml`) avoids it.
- **Requests to `/api/...` return 404:** the API has no `/api` prefix any more (`/auth/me`, `/cart`, ...). Hard refresh
  the client and sign in once; the old refresh cookie lived under `/api/auth`.
- **Signed out with "Your session has expired":** the refresh session ended (30 days idle, 90 days at most, or logged
  out everywhere / password changed on another device). Sign in again.

Seed data comes from [DummyJSON](https://dummyjson.com), converted to INR.
