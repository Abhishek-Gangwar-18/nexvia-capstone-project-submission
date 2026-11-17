# Vendora: test results and performance

Results measured on **17–18 November 2026** on branch `feat/typescript`: automated tests, type checks, an end-to-end
run of the Docker stack, and API performance numbers. Every number here comes from a real run; how to repeat each
one is at the end.

## Test environment

| Item | Value |
|---|---|
| Machine | Windows 11 laptop, Docker Desktop (Docker 29.9) |
| Runtime | Node.js 24.18 (local), `node:24-alpine` (containers) |
| Stack under test | `docker compose`: `api` (Node 24), `web` (nginx 1.27), Redis 7, Elasticsearch 8.19, MongoDB 7 (single node, local container) |
| Data | Demo seed: 5 stores, 20 customers, 184 products, ~1,180 ratings/reviews, 210 orders, coupons |
| External services | AWS S3 and Stripe test mode connected (no uploads or payments were made during the runs) |

The runs used a throwaway local MongoDB, not the Atlas cluster, so no real data was touched. MongoDB Atlas adds network
latency to uncached queries; Redis caching hides most of it on repeated reads.

---

## 1. Automated checks

| Check | Command | Result | Time |
|---|---|---|---|
| API unit tests | `pnpm --dir server test` | **75 / 78 pass**, 24 suites | 11.7 s |
| API type check | `pnpm --dir server typecheck` | **0 errors** (84 files) | 7.5 s |
| Client type check | `pnpm --dir client typecheck` | **0 errors** (77 files) | 5.4 s |
| Client production build | `pnpm --dir client build` | **Pass** | 5.1 s |

### Unit test suites

The tests run without a database or external services (fakes for Redis, Elasticsearch, Stripe and the models).

| File | What it covers |
|---|---|
| `orders.test.ts` | Package status transition rules, package locks, refunds when a package is cancelled, refund retry never pays twice |
| `payments.test.ts` | Payment capture confirmation, payment status after returns, payout reversal |
| `returns.test.ts` | Return requests (limits, duplicates), refund summaries, payout job together with returns |
| `cache.test.ts` | Locks and rate-limit store, in memory and with Redis, including a dropped Redis connection |
| `search.test.ts` | Elasticsearch index build, searching, and the fallback to MongoDB |
| `blocked.test.ts` | Blocked accounts: sessions end, the blocked cookie, `/auth/status` |
| `adminOrders.test.ts` | Admin order filters: date ranges, exceptions (late dispatch, payment mismatches), CSV export |
| `uploads.test.ts` | Image type check (real file signature, not the extension), deleting replaced images |
| `startup.test.ts` | App builds with every route mounted; production safety checks (Redis, Stripe keys, test gateway) |

### Known failures (3)

All 3 failures are in `startup.test.ts` and **also fail on `main` before the TypeScript work**:

- *the server refuses to start without REDIS_URL unless ALLOW_MEMORY_CACHE is set*
- *the server refuses to start when REDIS_URL is set but Redis is unreachable*
- *the server refuses to start without Stripe keys unless explicitly allowed*

**Cause:** a later commit made production refuse a plain `http://` Elasticsearch URL. These tests still start the
server in production mode with an `http://` URL, so it stops at that check before the one each test is about.
The app is right; the test setup needs an `https://` URL. To be fixed in the tests.

---

## 2. End-to-end check (Docker stack)

`docker compose up -d --build`, then each request through nginx on the web port, as a browser would make it.

| Check | Result |
|---|---|
| Both images build; all containers healthy | ✅ |
| `/health`: database, Redis, Elasticsearch, S3 and Stripe connected | ✅ |
| Pages `/`, `/cart`, `/orders`, `/admin` (opened directly) | ✅ 200, the app loads |
| Product search through Elasticsearch | ✅ 30 results for "phone" |
| Customer login, session refresh (`/auth/refresh`) | ✅ |
| Add to cart (Redis), live cart updates (Server-Sent Events through nginx) | ✅ |
| Order invoice download | ✅ real PDF (`application/pdf`) |
| Product reviews | ✅ |
| Seller: products, coupons, dashboard | ✅ |
| Logged-out request to a protected route | ✅ 401 |
| API container restarted | ✅ recovers on its own |
| Static files gzip-compressed and cached for a year | ✅ |
| API runs as a non-root user; no `.env` secrets in either image | ✅ |
| Errors or warnings in the API log | ✅ none |
| Every main page renders (21 screenshots in [screenshots/](screenshots/)) | ✅ after one fix: nginx now sends `Vary: Accept` so a cached page can't answer an API call (order detail was blank) |

---

## 3. Performance

### How it was measured

A small Node script sent requests from inside the Docker network straight to the API container (no browser, no
Windows-to-Docker network hop). Each endpoint got 5 warm-up requests first. The API limits each client to
600 requests per minute, so the benchmark gave every request its own test client address; otherwise most requests
would have been rejected with 429 and the numbers would be meaningless.

### API latency, one request at a time (100 requests per endpoint)

| Endpoint | p50 ms | p95 ms | req/s |
|---|---|---|---|
| `GET /health` | 0.9 | 1.8 | 923 |
| `GET /products/:id` | 1.3 | 2.4 | 688 |
| `GET /stores` | 1.1 | 1.8 | 823 |
| `GET /home` | 2.6 | 4.0 | 357 |
| `GET /orders` (signed in) | 3.2 | 5.1 | 290 |
| `GET /cart` (signed in) | 3.9 | 5.3 | 246 |
| `GET /products/suggest?q=lap` (typeahead) | 4.7 | 6.2 | 206 |
| `GET /products` filters + sort | 5.0 | 6.3 | 196 |
| `GET /products?q=iphnoe` (typo) | 5.5 | 7.2 | 175 |
| `GET /products?q=phone` (search) | 6.1 | 9.7 | 152 |
| `GET /products` (list, 24 items) | 6.8 | 8.1 | 147 |
| `GET /orders/:id/invoice` (PDF) | 8.9 | 12.5 | 107 |

No errors. Every read endpoint answers in **under 10 ms at p95**, except the PDF invoice at 12.5 ms.

### Under load: 20 concurrent clients (400 requests per endpoint)

| Endpoint | p50 ms | p95 ms | req/s |
|---|---|---|---|
| `GET /health` | 6.2 | 35.2 | 2,302 |
| `GET /products/:id` | 8.7 | 11.8 | 2,210 |
| `GET /stores` | 8.3 | 16.1 | 2,132 |
| `GET /home` | 17.1 | 26.8 | 1,149 |
| `GET /products/suggest?q=lap` | 18.4 | 25.9 | 1,047 |
| `GET /products` filters + sort | 20.2 | 27.9 | 967 |
| `GET /products?q=phone` | 21.4 | 28.4 | 917 |
| `GET /products?q=iphnoe` | 21.8 | 31.4 | 895 |
| `GET /products` (list) | 23.1 | 31.6 | 845 |
| `GET /orders` (signed in) | 29.1 | 34.7 | 671 |
| `GET /cart` (signed in) | 31.2 | 39.7 | 621 |
| `GET /orders/:id/invoice` (PDF) | 129.7 | 158.8 | 150 |

No errors. A single API process (one Node.js instance, no clustering) serves **600–2,300 requests per second** on
the read endpoints, with p95 under 40 ms. PDF generation is CPU-bound and the slowest at 150 per second; invoices are
downloaded rarely, so that is acceptable.

### Elasticsearch vs the MongoDB fallback

The same requests with the Elasticsearch container stopped. The API notices, logs
`Elasticsearch unreachable -> search runs on MongoDB, reconnecting every 15 s`, and keeps answering.

**Search quality**: results for the same queries:

| Query | Elasticsearch | MongoDB fallback |
|---|---|---|
| `phone` | 30 results | 24 results |
| `laptop` | 5 | 5 |
| `iphnoe` (typo) | **7** (iPhone 6, iPhone 5s, iPhone 13 Pro, …) | **0** |
| `macbok` (typo) | **1** (Apple MacBook Pro 14) | **0** |
| `nike earbuds` (no product has both words) | **4** partial matches, flagged as relaxed | **0** |

**Speed** (one request at a time, p50 / p95 ms):

| Endpoint | Elasticsearch | MongoDB fallback |
|---|---|---|
| `GET /products?q=phone` | 6.1 / 9.7 | 5.5 / 6.4 |
| `GET /products` filters + sort | 5.0 / 6.3 | 9.0 / 11.0 |
| `GET /products` (list) | 6.8 / 8.1 | 10.8 / 12.5 |
| `GET /products/suggest?q=lap` | 4.7 / 6.2 | 3.4 / 4.7 |

**Takeaway:** with 184 products both are fast, and MongoDB is even slightly faster on plain text queries. Elasticsearch
is clearly faster on filtered and sorted lists (about 45% lower p50). Its real value is **search quality**: typo
tolerance, synonyms and partial matches, where the fallback returns nothing. Elasticsearch's speed advantage grows
with catalogue size; the fallback keeps the shop usable during an outage.

### Frontend bundle (production build)

| File | Size | Gzipped |
|---|---|---|
| App code (`index-*.js`) | 427 kB | 133 kB |
| Charts (Recharts, admin/seller dashboards only) | 395 kB | 109 kB |
| Animations (Framer Motion) | 141 kB | 47 kB |
| React + router | 52 kB | 18 kB |
| CSS (Tailwind) | 137 kB | 19 kB |

Pages are split into separate chunks and load on demand, so a customer never downloads the charts chunk. nginx serves
these files gzip-compressed with a one-year cache (file names change with every build).

### Docker images

| Image | Size on disk | Download (compressed) |
|---|---|---|
| `api` (Node 24, production dependencies only) | 499 MB | 112 MB |
| `web` (nginx + built app) | 76 MB | 21 MB |

---

## How to repeat

```bash
pnpm --dir server test
pnpm --dir server typecheck
pnpm --dir client typecheck
pnpm --dir client build

docker compose up -d --build   # end-to-end: open http://localhost:8080
```

Use a local or throwaway database for load tests, never the live one. The manual Postman plan for every endpoint is in
[API_TESTS.md](API_TESTS.md).
