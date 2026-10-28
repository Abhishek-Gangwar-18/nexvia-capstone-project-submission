   # Vendora: multi-vendor e-commerce marketplace

An Amazon-style marketplace where many sellers list products, customers buy from several stores in one checkout, and
the platform splits each payment between the sellers and its own commission.

**Stack:** React 19 (Vite, Tailwind CSS v4, Framer Motion, TanStack Query, Zustand, Recharts) · Node.js + Express ·
MongoDB (Mongoose) · Elasticsearch 8 · Redis · AWS S3 · Razorpay Orders + Route (test mode)

> The architecture, database schema, order lifecycle, payment-split flow and full API list are in
> **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Features

**Customers**
- Storefront with an animated hero, categories, deals of the day with a live countdown, trending products, top stores and recently viewed items
- Search with typeahead (Elasticsearch `search_as_you_type`), faceted filters (category, brand, price slider, rating, in stock), seven sort orders, shareable URLs
- Product page with a zoomable gallery, offers, pincode delivery check, seller card, specs, and reviews with a rating breakdown and verified-purchase badges
- Cart stored in Redis (the guest cart is merged after login), free-shipping meter, coupons, save for later
- Two-step checkout with address book, per-seller package preview, and Razorpay Checkout (or the built-in test gateway)
- Order tracking timeline for each package, PDF invoices, cancel and refund, retry payment, wishlist, profile, dark mode

**Sellers**
- Four-step onboarding (store, business, payouts and Route account), then admin approval and a live store page
- Dashboard with KPIs vs the previous period, a sales chart, payouts on hold and released, top products and low-stock alerts
- Product editor with drag-and-drop S3 uploads (reorder, pick cover), tags, specs, an earnings estimate and live preview
- Fulfilment: packed, then shipped (tracking id), then delivered, which releases the payout; or cancel, which restocks, refunds and reverses the payout
- Store coupons, payout ledger, store settings

**Admin**
- Analytics (7D, 30D, 90D, 1Y): GMV, commission revenue, orders, AOV with change, revenue trend, package fulfilment, sales by category, top sellers and products
- Seller approvals (approve, reject with reason, suspend), per-seller commission override, Razorpay linked account
- Order management with package controls, product moderation, user blocking (revokes sessions immediately), platform coupons
- Settings (commission, shipping rules) with a live **system status** panel and an Elasticsearch reindex button

---

## Run it locally

**Requirements:** Node.js 18.18 or newer (tested on Node 24). Nothing else: MongoDB, Redis, Elasticsearch, S3 and
Razorpay all fall back to local equivalents automatically.

```bash
npm run install:all     # installs root, server and client dependencies
npm run dev             # starts the database, API (http://localhost:5050) and web app (http://localhost:5180)
```

Open **http://localhost:5180**.

- **First run:** `npm run db` downloads a MongoDB binary (about 600 MB, one time only) and stores data in `server/.data/`.
- **Empty database:** the API seeds demo data automatically: 20 customers, 5 stores, 184 products from DummyJSON,
  about 1,170 reviews, 210 historical orders and coupons. Run `npm run seed` to reset to that data at any time.
- Run `npm run smoke` in `server/` while the API is up for an end-to-end test of the API. To include the admin checks,
  set `SMOKE_ADMIN_EMAIL` and `SMOKE_ADMIN_PASSWORD` to your admin login first.

### Seeded accounts

**No admin account is seeded.** The platform owner is the only admin; existing admin accounts are kept every time
`npm run seed` runs. To make your own account an admin, register it and then change its `role` field to `"admin"` in
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
| **MongoDB Atlas** | `MONGO_URI=mongodb+srv://<user>:<pass>@<cluster>/vendora?retryWrites=true&w=majority` | Add your IP under Atlas → Network Access. `npm run db` stays idle, an empty database is seeded on first start, and payments are finalized in multi-document transactions (Atlas is a replica set). If Node can't resolve the SRV record (`querySrv ECONNREFUSED` on some Windows setups), the API retries via public DNS automatically |
| **Redis** | `REDIS_URL=redis://localhost:6379` (or Upstash `rediss://...`) | Cart, session and page cache |
| **Elasticsearch** | `ELASTICSEARCH_NODE=http://localhost:9200` (+ `ELASTICSEARCH_API_KEY` for Elastic Cloud) | The index is created and filled automatically on startup |
| **AWS S3** | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` | The bucket needs public read for `products/*`, `stores/*` and `avatars/*`, or a CloudFront URL in `AWS_S3_PUBLIC_URL` |
| **Razorpay** | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (test keys) | Real Razorpay Checkout opens instead of the test gateway |

If you have Docker, `docker compose up -d` starts MongoDB 7, Redis 7 and Elasticsearch 8.19.

### Razorpay Route (split payments)

1. In the Razorpay Dashboard (test mode), copy the API keys into `server/.env`.
2. Enable **Route**, then create a **linked account** for each seller (Route → Linked accounts). You get an id like `acc_XXXXXXXX`.
3. Enter that id in the seller's onboarding/store settings, or as admin under **Vendors → Commission**.
4. At checkout the API creates the Razorpay order with a `transfers[]` entry for each linked seller (the seller's share
   after commission, `on_hold`). Marking a package **delivered** releases that transfer. Cancelling **reverses** it and
   refunds the customer.
5. Optional webhook: point `payment.captured` at `https://<api>/api/payments/webhook` and set `RAZORPAY_WEBHOOK_SECRET`.

Sellers without a linked account, or accounts without Route enabled, still work: the split is recorded in the payout
ledger and settled manually.

---

## Deploying (frontend and backend separately)

**Backend → Render** (`render.yaml` included) or any Node host
- Root directory: `server`, build command `npm install --omit=dev`, start command `npm start`, health check `/api/health`
- Environment: `NODE_ENV=production`, `MONGO_URI` (Atlas), `JWT_SECRET`, `CLIENT_URL=https://<your-vercel-app>`,
  `SERVER_URL=https://<your-api>`, plus Redis (Upstash), Elasticsearch (Elastic Cloud), S3 and Razorpay keys.
  Use S3 in production, because the host's local disk is wiped on every deploy.

**Frontend → Vercel** (`client/vercel.json` included) or Netlify
- Root directory: `client`, build `npm run build`, output `dist`
- Environment: `VITE_API_URL=https://<your-api>`

---

## Project structure

```
├── client/                  React SPA (Vite)
│   └── src/
│       ├── components/      layout, product, checkout, dashboard, orders, ui
│       ├── pages/           storefront, account, vendor/*, admin/*, auth/*
│       ├── lib/             api client, session, cart hooks, formatting, Razorpay loader
│       └── store/           Zustand stores (auth, guest cart, theme)
├── server/                  Express API
│   ├── src/
│   │   ├── config/          env, MongoDB connection
│   │   ├── models/          User, Vendor, Product, Category, Review, Coupon, Cart, Order, Settings
│   │   ├── services/        cache (Redis), search (Elasticsearch), storage (S3), payment (Razorpay),
│   │   │                    cart, pricing, orders, invoice (PDFKit), session, catalog
│   │   ├── controllers/     auth, catalog, cart, order, vendor, coupon, admin
│   │   ├── routes/          route definitions with zod validation + RBAC middleware
│   │   ├── middleware/      auth/RBAC, validation, uploads, errors
│   │   └── seed/            seed script + DummyJSON snapshot
│   └── scripts/             local-db (embedded MongoDB), smoke-test
├── docs/ARCHITECTURE.md     roles, schema, lifecycle, payment split, API list
├── docker-compose.yml       optional MongoDB / Redis / Elasticsearch
└── render.yaml              backend deploy blueprint
```

## Troubleshooting

- **Port 5050 is busy:** change `PORT` and `SERVER_URL` in `server/.env`, and the proxy target in `client/vite.config.js`.
- **"Cannot reach the server":** make sure the `api` process in `npm run dev` says `Vendora API ready`.
- **MongoDB download is slow:** this happens once. Alternatively, set `MONGO_URI` to a free Atlas cluster.
- **Stale pages after `npm run seed`:** restart the API so the in-memory cache is cleared. With Redis, the seed script clears it for you.

Seed data comes from [DummyJSON](https://dummyjson.com), converted to INR.
