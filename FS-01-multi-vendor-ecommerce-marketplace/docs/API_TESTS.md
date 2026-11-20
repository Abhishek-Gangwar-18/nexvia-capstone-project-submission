# Vendora API — end-to-end test plan (Postman)

Every endpoint, with happy and error cases, the expected result, and a curl you can paste into Postman
(**Import → Raw text**). Curls use Postman variables (`{{baseUrl}}`, `{{customerToken}}`, …): create an
environment with the variables below and fill each one when its section tells you where the value comes from.

Run the sections **in order**. A few cases change data; they are marked ⚠ and say how to undo them.

**Automated version:** every case below also runs as `pnpm --dir server test:integration` (232 checks, see
[TEST_RESULTS.md](TEST_RESULTS.md)). It changes data, so point it at a throwaway database, never Atlas.

---

## 0. Setup

### Environment variables

| Variable | Initial value / where it comes from |
|---|---|
| `baseUrl` | `http://localhost:5050` (no `/api` prefix any more). With the Docker stack (`docker compose up -d --build`) use `http://localhost:8080`: nginx forwards every API path to the API |
| `customerToken` | 2.6 login `customer@vendora.dev` / `Customer@123` → response `accessToken` |
| `customer2Token` | 2.9 login `ananya.gupta@example.com` / `Customer@123` → `accessToken` |
| `vendorToken` | 2.10 login `technova@vendora.dev` / `Vendor@123` → `accessToken` |
| `adminToken` | 2.11 login with your admin account (no admin is seeded; see the README) → `accessToken` |
| `newUserEmail` | the email you used in 2.1 |
| `newUserToken` | 2.1 register → `accessToken` |
| `storeId` | 3.10 `GET /stores?q=TechNova` → `items[0]._id` (TechNova's vendor id) |
| `productId` | 3.4 `GET /products?vendor={{storeId}}&inStock=true` → `items[0]._id` (an in-stock TechNova product) |
| `otherProductId` | 3.3 `GET /products` → any `items[i]._id` whose `vendor` is **not** TechNova |
| `categoryId` | 3.2 `GET /categories` → `categories[0]._id` |
| `addressId` | 2.25 add address → `address._id` |
| `deliveredProductId` | 4.0 `GET /orders?status=delivered` (customer) → `items[0].packages[0].items[0].product` |
| `reviewId` | 4.10 create review → `review._id` |
| `orderA`, `orderB` | 6.7 / 6.10 checkout → `order._id` |
| `couponCode` | 3.12 `GET /coupons` → `coupons[0].code` (platform coupon, `vendor: null`) |
| `vendorProductId` | 7.12 create product → `product._id` |
| `vendorReviewId` | 7.24 `GET /vendor/reviews?replied=no` → `items[0]._id` |
| `vendorCouponId` | 7.28 create coupon → `coupon._id` |
| `newStoreId` | 7.2 onboard (new user) → `vendor._id` |
| `newUserId` | 8.6 `GET /admin/users?q={{newUserEmail}}` → `items[0]._id` |
| `adminOrderId`, `adminPackageId` | 8.14 `GET /admin/orders?fulfilment=placed` → `items[0]._id` and `items[0].fulfilment[0]._id` |
| `adminCategoryId` | 8.30 create category → `category._id` |
| `adminCouponId` | 8.36 create coupon → `coupon._id` |

### Things to know
- **Automated checks first:** `pnpm --dir server test` (API unit tests), `pnpm --dir server typecheck` and
  `pnpm --dir client typecheck` (TypeScript), `pnpm --dir client build`.
- **Refresh calls need `X-Requested-With: vendora`** (the app sends it on every request); without it
  `/auth/refresh` answers 403.
- **Access tokens live 15 minutes.** On `401 "Your session has expired"`, log in again (or use 2.15 refresh).
- **Error shape:** `{ "message": "...", "details"?: { "fields": { "<field>": "<message>" }, "code"?: "..." } }`.
  Validation errors read `"<field>: <message>"`.
- **Postman keeps one refresh cookie per host** (path `/auth`): it belongs to whoever logged in **last**.
  That only matters for `/auth/refresh` and `/auth/logout` (2.15–2.17, 2.46).
- **Rate limits:** login/register 50 per 15 min, password change 5 per 15 min,
  everything 600 per minute. A 429 after many retries is expected.

---

## 1. System

| # | Case | Expected |
|---|---|---|
| 1.1 | Root | 200 `{ name: "Vendora API", docs: "/health", client }` |
| 1.2 | Health | 200 `{ status: "ok", uptime, services: { database: "connected", cache, search, storage, payments } }` |
| 1.3 | Old `/api` prefix | 404 `Route not found: GET /api/health` (API port only: through Docker's port 8080, nginx serves the web app for paths that aren't API routes) |
| 1.4 | Unknown route | 404 `Route not found: GET /nope` (API port only, as 1.3) |
| 1.5 | Webhook with a bad signature | 400 `Invalid webhook signature`; without `STRIPE_WEBHOOK_SECRET` set: 400 `Stripe webhooks are not configured` |

```bash
# 1.1
curl -i "{{baseUrl}}/"
# 1.2
curl -i "{{baseUrl}}/health"
# 1.3
curl -i "{{baseUrl}}/api/health"
# 1.4
curl -i "{{baseUrl}}/nope"
# 1.5
curl -i -X POST "{{baseUrl}}/payments/webhook" -H "Content-Type: application/json" -H "Stripe-Signature: t=1,v1=bad" -d '{"type":"payment_intent.succeeded"}'
```

---

## 2. Auth (`/auth`)

| # | Case | Expected |
|---|---|---|
| 2.1 | Register a new customer (use a fresh email, e.g. `test+{{$timestamp}}@example.com`) | 201 `{ accessToken, user: { role: "customer" } }` → save `newUserToken`, `newUserEmail` |
| 2.2 | Register the same email again | 409 `An account with this email already exists` |
| 2.3 | Password shorter than 8 | 400 `password: Password must be at least 8 characters` |
| 2.4 | Invalid email | 400 `email: Enter a valid email address` |
| 2.5 | `role: "admin"` | 400 `role: Invalid enum value...` |
| 2.6 | Login (customer) | 200 `{ accessToken, user }` + `Set-Cookie: vendora_rt=...; Path=/auth; HttpOnly` → save `customerToken` |
| 2.7 | Wrong password | 401 `Incorrect email or password` |
| 2.8 | Missing password | 400 `password: Required` (an empty password `""` gives `password: Password is required`) |
| 2.9–2.11 | Login customer2, vendor, admin | 200 → save `customer2Token`, `vendorToken`, `adminToken` |
| 2.12 | `GET /auth/me` | 200 `{ user }` (vendor users also get `user.vendor`) |
| 2.13 | `/auth/me` without a token | 401 `Please log in to continue` |
| 2.14 | `/auth/me` with a garbage token | 401 `Please log in to continue` (`code: INVALID_TOKEN`) |
| 2.15 | Refresh (Postman sends the cookie) with `X-Requested-With: vendora` | 200 `{ accessToken, user }` for the **last logged-in** user, new cookie |
| 2.16 | Refresh without `X-Requested-With` | 403 `Missing X-Requested-With header` |
| 2.17 | Refresh with no cookie (Postman: Cookies → delete `vendora_rt` first) | 401 `Please log in to continue` (`code: NO_SESSION`) |
| 2.18 | List sessions | 200 `{ sessions: [...] }`, exactly one has `current: true` |
| 2.19 | Revoke session `abc` | 400 `Invalid session id` |
| 2.20 | Revoke unknown session `000000000000000000000000` | 404 `Session not found` |
| 2.21 | `PATCH /auth/me` `{ name }` | 200 `{ user }` with the new name |
| 2.22 | `PATCH /auth/me` phone `12345` | 400 `phone: Enter a valid 10-digit mobile number` |
| 2.23 | Phone already used by another user (copy any `phone` from `GET /admin/users`, 8.5) | 409 `This phone number is already registered` |
| 2.24 | List addresses | 200 `{ addresses }` |
| 2.25 | Add address | 201 `{ addresses, address }` → save `addressId = address._id` |
| 2.26 | Add address, pincode `12` | 400 `pincode: Pincode must be 6 digits` |
| 2.27 | Update address `{ city }` | 200 `{ addresses }` with the new city |
| 2.28 | Update address `{}` | 400 `Send at least one field to update` |
| 2.29 | Update unknown address `000000000000000000000000` | 404 `Address not found` |
| 2.30 | Wishlist | 200 `{ items }` |
| 2.31 | `PUT /me/wishlist/{{productId}}` (twice) | 200 `{ wishlisted: true, wishlist }` both times, product listed once |
| 2.32 | `DELETE /me/wishlist/{{productId}}` (twice) | 200 `{ wishlisted: false }` both times |
| 2.33 | Wishlist `abc` | 400 `Invalid _id` |
| 2.34 | Wishlist unknown product `000000000000000000000000` | 404 `Product not found` |
| 2.42 | Change password (newUser), wrong current | 400 `Current password is incorrect` |
| 2.43 | Change password, new one too short | 400 `newPassword: New password must be at least 8 characters` |
| 2.44 | Change password (newUser) | 200 `{ message, accessToken }` → **replace `newUserToken`** with it |
| 2.45 | Old newUser token after 2.44 | 401 `Your password was changed. Please log in again.` (or `logged out`) |
| 2.46 | Logout (newUser) then reuse that token | 200 `Logged out`, then 401 on `/auth/me`. Log newUser in again (new password) and save `newUserToken` |
| 2.47 | Logout all devices (newUser) | 200 `Logged out of N device(s)`; log in again afterwards |
| 2.48 | Delete address | 200 `{ addresses }` without it; repeat → 404. **Re-run 2.25** so `addressId` exists for checkout |

```bash
# 2.1
curl -i -X POST "{{baseUrl}}/auth/register" -H "Content-Type: application/json" -d '{"name":"Test User","email":"test+{{$timestamp}}@example.com","password":"Test@1234"}'
# 2.2  (use the email from 2.1)
curl -i -X POST "{{baseUrl}}/auth/register" -H "Content-Type: application/json" -d '{"name":"Test User","email":"{{newUserEmail}}","password":"Test@1234"}'
# 2.3
curl -i -X POST "{{baseUrl}}/auth/register" -H "Content-Type: application/json" -d '{"name":"Test User","email":"short@example.com","password":"123"}'
# 2.4
curl -i -X POST "{{baseUrl}}/auth/register" -H "Content-Type: application/json" -d '{"name":"Test User","email":"not-an-email","password":"Test@1234"}'
# 2.5
curl -i -X POST "{{baseUrl}}/auth/register" -H "Content-Type: application/json" -d '{"name":"Test User","email":"admin2@example.com","password":"Test@1234","role":"admin"}'
# 2.6
curl -i -X POST "{{baseUrl}}/auth/login" -H "Content-Type: application/json" -d '{"email":"customer@vendora.dev","password":"Customer@123"}'
# 2.7
curl -i -X POST "{{baseUrl}}/auth/login" -H "Content-Type: application/json" -d '{"email":"customer@vendora.dev","password":"wrong-pass"}'
# 2.8
curl -i -X POST "{{baseUrl}}/auth/login" -H "Content-Type: application/json" -d '{"email":"customer@vendora.dev"}'
# 2.9
curl -i -X POST "{{baseUrl}}/auth/login" -H "Content-Type: application/json" -d '{"email":"ananya.gupta@example.com","password":"Customer@123"}'
# 2.10
curl -i -X POST "{{baseUrl}}/auth/login" -H "Content-Type: application/json" -d '{"email":"technova@vendora.dev","password":"Vendor@123"}'
# 2.11
curl -i -X POST "{{baseUrl}}/auth/login" -H "Content-Type: application/json" -d '{"email":"YOUR_ADMIN_EMAIL","password":"YOUR_ADMIN_PASSWORD"}'
# 2.12
curl -i "{{baseUrl}}/auth/me" -H "Authorization: Bearer {{customerToken}}"
# 2.13
curl -i "{{baseUrl}}/auth/me"
# 2.14
curl -i "{{baseUrl}}/auth/me" -H "Authorization: Bearer garbage.token.value"
# 2.15
curl -i -X POST "{{baseUrl}}/auth/refresh" -H "X-Requested-With: vendora"
# 2.16
curl -i -X POST "{{baseUrl}}/auth/refresh"
# 2.17  (delete the vendora_rt cookie in Postman first)
curl -i -X POST "{{baseUrl}}/auth/refresh" -H "X-Requested-With: vendora"
# 2.18
curl -i "{{baseUrl}}/auth/sessions" -H "Authorization: Bearer {{customerToken}}"
# 2.19
curl -i -X DELETE "{{baseUrl}}/auth/sessions/abc" -H "Authorization: Bearer {{customerToken}}"
# 2.20
curl -i -X DELETE "{{baseUrl}}/auth/sessions/000000000000000000000000" -H "Authorization: Bearer {{customerToken}}"
# 2.21
curl -i -X PATCH "{{baseUrl}}/auth/me" -H "Authorization: Bearer {{newUserToken}}" -H "Content-Type: application/json" -d '{"name":"Test User Renamed"}'
# 2.22
curl -i -X PATCH "{{baseUrl}}/auth/me" -H "Authorization: Bearer {{newUserToken}}" -H "Content-Type: application/json" -d '{"phone":"12345"}'
# 2.23  (replace 98XXXXXXXX with another user's phone)
curl -i -X PATCH "{{baseUrl}}/auth/me" -H "Authorization: Bearer {{newUserToken}}" -H "Content-Type: application/json" -d '{"phone":"98XXXXXXXX"}'
# 2.24
curl -i "{{baseUrl}}/auth/me/addresses" -H "Authorization: Bearer {{customerToken}}"
# 2.25
curl -i -X POST "{{baseUrl}}/auth/me/addresses" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"label":"Test","fullName":"Test Customer","phone":"9876543210","line1":"12 MG Road","city":"Bengaluru","state":"Karnataka","pincode":"560001"}'
# 2.26
curl -i -X POST "{{baseUrl}}/auth/me/addresses" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"fullName":"Test Customer","phone":"9876543210","line1":"12 MG Road","city":"Bengaluru","state":"Karnataka","pincode":"12"}'
# 2.27
curl -i -X PATCH "{{baseUrl}}/auth/me/addresses/{{addressId}}" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"city":"Mysuru"}'
# 2.28
curl -i -X PATCH "{{baseUrl}}/auth/me/addresses/{{addressId}}" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{}'
# 2.29
curl -i -X PATCH "{{baseUrl}}/auth/me/addresses/000000000000000000000000" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"city":"Mysuru"}'
# 2.30
curl -i "{{baseUrl}}/auth/me/wishlist" -H "Authorization: Bearer {{customerToken}}"
# 2.31  (send twice)
curl -i -X PUT "{{baseUrl}}/auth/me/wishlist/{{productId}}" -H "Authorization: Bearer {{customerToken}}"
# 2.32  (send twice)
curl -i -X DELETE "{{baseUrl}}/auth/me/wishlist/{{productId}}" -H "Authorization: Bearer {{customerToken}}"
# 2.33
curl -i -X PUT "{{baseUrl}}/auth/me/wishlist/abc" -H "Authorization: Bearer {{customerToken}}"
# 2.34
curl -i -X PUT "{{baseUrl}}/auth/me/wishlist/000000000000000000000000" -H "Authorization: Bearer {{customerToken}}"
# 2.42
curl -i -X PATCH "{{baseUrl}}/auth/me/password" -H "Authorization: Bearer {{newUserToken}}" -H "Content-Type: application/json" -d '{"currentPassword":"wrong-pass","newPassword":"Test@5678"}'
# 2.43
curl -i -X PATCH "{{baseUrl}}/auth/me/password" -H "Authorization: Bearer {{newUserToken}}" -H "Content-Type: application/json" -d '{"currentPassword":"Test@1234","newPassword":"123"}'
# 2.44
curl -i -X PATCH "{{baseUrl}}/auth/me/password" -H "Authorization: Bearer {{newUserToken}}" -H "Content-Type: application/json" -d '{"currentPassword":"Test@1234","newPassword":"Test@5678"}'
# 2.45  (the token from BEFORE 2.44)
curl -i "{{baseUrl}}/auth/me" -H "Authorization: Bearer OLD_NEWUSER_TOKEN"
# 2.46
curl -i -X POST "{{baseUrl}}/auth/logout" -H "Authorization: Bearer {{newUserToken}}"
curl -i "{{baseUrl}}/auth/me" -H "Authorization: Bearer {{newUserToken}}"
curl -i -X POST "{{baseUrl}}/auth/login" -H "Content-Type: application/json" -d '{"email":"{{newUserEmail}}","password":"Test@5678"}'
# 2.47
curl -i -X POST "{{baseUrl}}/auth/logout-all" -H "Authorization: Bearer {{newUserToken}}"
# 2.48
curl -i -X DELETE "{{baseUrl}}/auth/me/addresses/{{addressId}}" -H "Authorization: Bearer {{customerToken}}"
```

---

## 3. Catalog (public)

| # | Case | Expected |
|---|---|---|
| 3.1 | Home feed | 200 `{ categories, trending, topRated, newArrivals, deals, vendors }` |
| 3.2 | Categories | 200 `{ categories: [{ _id, name, productCount, ... }] }` → save `categoryId` |
| 3.3 | Products, first page | 200 `{ items, total, page, limit, pages, facets, engine, relaxed }` |
| 3.4 | Products filtered by store, in stock, sorted | 200, every item's vendor is TechNova → save `productId` |
| 3.5 | Price range + rating + category | 200, all items match |
| 3.6 | Unknown sort / huge limit | 200, falls back to `popular`, `limit` capped at 48 |
| 3.7 | Suggest `q=ph` | 200 `{ products, categories, didYouMean: null }` |
| 3.7b | Suggest `q=samsng` (typo, Elasticsearch on) | 200 `didYouMean: "samsung"` |
| 3.8 | Suggest `q=a` (too short) | 200 `{ products: [], categories: [], didYouMean: null }` |
| 3.9 | Product detail | 200 `{ product, related, category, store }` |
| 3.9b | Product `abc` / unknown id | 400 `Invalid product id` / 404 `Product not found` |
| 3.10 | Stores search | 200 paginated → save `storeId` |
| 3.11 | Store detail / `abc` / unknown | 200 `{ store }` / 400 `Invalid store id` / 404 `Store not found` |
| 3.12 | Public coupons (+ a store's coupons) | 200 `{ coupons }`, private and expired ones left out; with a token, coupons that customer has used up are left out too → save `couponCode` |
| 3.13 | Upload an image (Postman: Body → form-data, key `images`, type File) | 201 `{ files: [{ url, key }] }`, key `avatars/{date}/{your user id}/{uuid}.jpg` |
| 3.14 | Upload with no file | 400 `Choose at least one image to upload` |
| 3.15 | Upload with `folder=bad` | 400 `folder must be one of: products, stores, avatars, reviews, returns` |
| 3.16 | Customer uploads to `folder=products` | 403 `Only sellers can upload product images` |
| 3.17 | Upload a `.txt` file | 400 `Unsupported file type text/plain...` |
| 3.17b | Upload a text file renamed to `.jpg` | 400 `fake.jpg is not a valid image...` |
| 3.18 | Upload without a token | 401 |

```bash
# 3.1
curl -i "{{baseUrl}}/home"
# 3.2
curl -i "{{baseUrl}}/categories"
# 3.3
curl -i "{{baseUrl}}/products?page=1&limit=5"
# 3.4
curl -i "{{baseUrl}}/products?vendor={{storeId}}&inStock=true&sort=popular&limit=5"
# 3.5
curl -i "{{baseUrl}}/products?category={{categoryId}}&minPrice=100&maxPrice=50000&rating=4&sort=price_asc"
# 3.6
curl -i "{{baseUrl}}/products?sort=bogus&limit=500"
# 3.7
curl -i "{{baseUrl}}/products/suggest?q=ph"
# 3.7b
curl -i "{{baseUrl}}/products/suggest?q=samsng"
# 3.8
curl -i "{{baseUrl}}/products/suggest?q=a"
# 3.9
curl -i "{{baseUrl}}/products/{{productId}}"
# 3.9b
curl -i "{{baseUrl}}/products/abc"
curl -i "{{baseUrl}}/products/000000000000000000000000"
# 3.10
curl -i "{{baseUrl}}/stores?q=TechNova&sort=rating&page=1&limit=5"
# 3.11
curl -i "{{baseUrl}}/stores/{{storeId}}"
curl -i "{{baseUrl}}/stores/abc"
curl -i "{{baseUrl}}/stores/000000000000000000000000"
# 3.12
curl -i "{{baseUrl}}/coupons"
curl -i "{{baseUrl}}/coupons?vendors={{storeId}}"
# 3.13  (pick a real image path)
curl -i -X POST "{{baseUrl}}/uploads?folder=avatars" -H "Authorization: Bearer {{customerToken}}" -F "images=@/path/to/photo.jpg"
# 3.14
curl -i -X POST "{{baseUrl}}/uploads?folder=avatars" -H "Authorization: Bearer {{customerToken}}"
# 3.15
curl -i -X POST "{{baseUrl}}/uploads?folder=bad" -H "Authorization: Bearer {{customerToken}}" -F "images=@/path/to/photo.jpg"
# 3.16
curl -i -X POST "{{baseUrl}}/uploads?folder=products" -H "Authorization: Bearer {{customerToken}}" -F "images=@/path/to/photo.jpg"
# 3.17
curl -i -X POST "{{baseUrl}}/uploads?folder=avatars" -H "Authorization: Bearer {{customerToken}}" -F "images=@/path/to/notes.txt"
# 3.17b  (a text file renamed to fake.jpg)
curl -i -X POST "{{baseUrl}}/uploads?folder=avatars" -H "Authorization: Bearer {{customerToken}}" -F "images=@/path/to/fake.jpg;type=image/jpeg"
# 3.18
curl -i -X POST "{{baseUrl}}/uploads?folder=avatars" -F "images=@/path/to/photo.jpg"
```

---

## 4. Ratings and reviews

Only a customer with a **delivered** order of the product can rate or review it.
**4.0:** run `GET /orders?status=delivered` with `customerToken` → `items[0].packages[0].items[0].product` = `deliveredProductId`.

| # | Case | Expected |
|---|---|---|
| 4.1 | List reviews (logged in) | 200 `{ items, total, ..., distribution, myRating, myReviewIds, myVotes, canReview: true, reviewsLeft }` |
| 4.2 | List reviews, `sort=helpful&rating=5`, no token | 200, only 5-star authors, `canReview: false` |
| 4.3 | Reviews of product `abc` | 400 `Invalid product id` |
| 4.4 | Rate 4 stars | 200 `{ rating: 4 }` |
| 4.5 | Rate 6 | 400 `value: Number must be less than or equal to 5` |
| 4.6 | Rate 0 | 400 `value: Pick a star rating` |
| 4.7 | Rate a product never delivered to you (`otherProductId`) | 403 `You can rate and review this product once an order with it has been delivered` |
| 4.8 | Rate an unknown product | 404 `Product not found` |
| 4.9 | Remove rating | 200 `{ rating: null }` (then rate again with 4.4 so the review below carries a rating) |
| 4.10 | Create review | 201 `{ review: { _id, authorRating: 4, verified: true, name } }` → save `reviewId` |
| 4.11 | Comment shorter than 10 characters | 400 `comment: Tell others a little more (at least 10 characters)` |
| 4.12 | Review a product not delivered to you | 403 (same message as 4.7) |
| 4.13 | Review without a token | 401 |
| 4.14 | Edit own review `{ title }` | 200 `{ review }` with the new title |
| 4.15 | Edit with `{}` | 400 `Send at least one field to update` |
| 4.16 | customer2 edits your review | 403 `You can only change your own reviews` |
| 4.17 | Edit review `abc` / unknown id | 400 `Invalid review id` / 404 `Review not found` |
| 4.18 | Mark own review helpful | 400 `You can't vote on your own review` |
| 4.19 | customer2 marks it helpful (twice) | 200 `{ helpful: true }`, counted once |
| 4.20 | customer2 removes the vote | 200 `{ helpful: false }` |
| 4.21 | Admin hides it without a reason | 400 `reason: A reason is required to hide a review` |
| 4.22 | Admin hides it | 200 `{ review: { moderation: { status: "hidden" } } }`; it disappears from 4.1 |
| 4.23 | Admin restores it | 200, status `visible` |
| 4.24 | customer2 deletes your review | 403 |
| 4.25 | Author deletes it (then again) | 200 `Review deleted`, then 404 |

```bash
# 4.0
curl -i "{{baseUrl}}/orders?status=delivered&limit=1" -H "Authorization: Bearer {{customerToken}}"
# 4.1
curl -i "{{baseUrl}}/products/{{deliveredProductId}}/reviews" -H "Authorization: Bearer {{customerToken}}"
# 4.2
curl -i "{{baseUrl}}/products/{{deliveredProductId}}/reviews?sort=helpful&rating=5&page=1&limit=6"
# 4.3
curl -i "{{baseUrl}}/products/abc/reviews"
# 4.4
curl -i -X PUT "{{baseUrl}}/products/{{deliveredProductId}}/rating" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"value":4}'
# 4.5
curl -i -X PUT "{{baseUrl}}/products/{{deliveredProductId}}/rating" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"value":6}'
# 4.6
curl -i -X PUT "{{baseUrl}}/products/{{deliveredProductId}}/rating" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"value":0}'
# 4.7
curl -i -X PUT "{{baseUrl}}/products/{{otherProductId}}/rating" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"value":4}'
# 4.8
curl -i -X PUT "{{baseUrl}}/products/000000000000000000000000/rating" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"value":4}'
# 4.9
curl -i -X DELETE "{{baseUrl}}/products/{{deliveredProductId}}/rating" -H "Authorization: Bearer {{customerToken}}"
# 4.10
curl -i -X POST "{{baseUrl}}/products/{{deliveredProductId}}/reviews" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"title":"API test review","comment":"Works well, delivered on time. (Postman test)"}'
# 4.11
curl -i -X POST "{{baseUrl}}/products/{{deliveredProductId}}/reviews" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"comment":"short"}'
# 4.12
curl -i -X POST "{{baseUrl}}/products/{{otherProductId}}/reviews" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"comment":"I never bought this product."}'
# 4.13
curl -i -X POST "{{baseUrl}}/products/{{deliveredProductId}}/reviews" -H "Content-Type: application/json" -d '{"comment":"No token on this request."}'
# 4.14
curl -i -X PATCH "{{baseUrl}}/products/{{deliveredProductId}}/reviews/{{reviewId}}" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"title":"Edited title"}'
# 4.15
curl -i -X PATCH "{{baseUrl}}/products/{{deliveredProductId}}/reviews/{{reviewId}}" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{}'
# 4.16
curl -i -X PATCH "{{baseUrl}}/products/{{deliveredProductId}}/reviews/{{reviewId}}" -H "Authorization: Bearer {{customer2Token}}" -H "Content-Type: application/json" -d '{"title":"Hijacked"}'
# 4.17
curl -i -X PATCH "{{baseUrl}}/products/{{deliveredProductId}}/reviews/abc" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"title":"x"}'
curl -i -X PATCH "{{baseUrl}}/products/{{deliveredProductId}}/reviews/000000000000000000000000" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"title":"x"}'
# 4.18
curl -i -X POST "{{baseUrl}}/products/{{deliveredProductId}}/reviews/{{reviewId}}/helpful" -H "Authorization: Bearer {{customerToken}}"
# 4.19  (send twice)
curl -i -X POST "{{baseUrl}}/products/{{deliveredProductId}}/reviews/{{reviewId}}/helpful" -H "Authorization: Bearer {{customer2Token}}"
# 4.20
curl -i -X DELETE "{{baseUrl}}/products/{{deliveredProductId}}/reviews/{{reviewId}}/helpful" -H "Authorization: Bearer {{customer2Token}}"
# 4.21
curl -i -X PATCH "{{baseUrl}}/admin/reviews/{{reviewId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"hidden"}'
# 4.22
curl -i -X PATCH "{{baseUrl}}/admin/reviews/{{reviewId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"hidden","reason":"Postman moderation test"}'
# 4.23
curl -i -X PATCH "{{baseUrl}}/admin/reviews/{{reviewId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"visible"}'
# 4.24
curl -i -X DELETE "{{baseUrl}}/products/{{deliveredProductId}}/reviews/{{reviewId}}" -H "Authorization: Bearer {{customer2Token}}"
# 4.25  (send twice)
curl -i -X DELETE "{{baseUrl}}/products/{{deliveredProductId}}/reviews/{{reviewId}}" -H "Authorization: Bearer {{customerToken}}"
```

---

## 5. Cart (customers only)

| # | Case | Expected |
|---|---|---|
| 5.1 | Get cart | 200 `{ items, summary }` |
| 5.2 | Set quantity 2 | 200, the line shows `quantity: 2` |
| 5.3 | Set quantity 3 for the same product | 200, `quantity: 3` (sets the total, does **not** add) |
| 5.4 | Quantity 11 | 400 `quantity: Number must be less than or equal to 10` |
| 5.5 | Quantity 0 | 400 `quantity: Number must be greater than or equal to 1` |
| 5.6 | productId `abc` | 400 `productId: Invalid product id` |
| 5.7 | Unknown product | 404 `This product is no longer available` |
| 5.8 | Vendor token | 403 `You do not have permission to perform this action` |
| 5.9 | No token | 401 |
| 5.10 | Coupon preview with `{{couponCode}}` | 200 discount preview, or 400 with the reason (e.g. `Add ₹X more...`, `You have already used this coupon`) |
| 5.11 | Unknown coupon | 404 `That coupon code is not valid` |
| 5.12 | Empty code | 400 `code: Enter a coupon code` |
| 5.13 | Remove the line | 200 cart without it |
| 5.14 | Clear the cart | 200 empty cart |
| 5.15 | Coupon on an empty cart | 400 `Your cart is empty` |

```bash
# 5.1
curl -i "{{baseUrl}}/cart" -H "Authorization: Bearer {{customerToken}}"
# 5.2
curl -i -X POST "{{baseUrl}}/cart/items" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"productId":"{{productId}}","quantity":2}'
# 5.3
curl -i -X POST "{{baseUrl}}/cart/items" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"productId":"{{productId}}","quantity":3}'
# 5.4
curl -i -X POST "{{baseUrl}}/cart/items" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"productId":"{{productId}}","quantity":11}'
# 5.5
curl -i -X POST "{{baseUrl}}/cart/items" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"productId":"{{productId}}","quantity":0}'
# 5.6
curl -i -X POST "{{baseUrl}}/cart/items" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"productId":"abc","quantity":1}'
# 5.7
curl -i -X POST "{{baseUrl}}/cart/items" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"productId":"000000000000000000000000","quantity":1}'
# 5.8
curl -i "{{baseUrl}}/cart" -H "Authorization: Bearer {{vendorToken}}"
# 5.9
curl -i "{{baseUrl}}/cart"
# 5.10
curl -i -X POST "{{baseUrl}}/cart/coupon" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"code":"{{couponCode}}"}'
# 5.11
curl -i -X POST "{{baseUrl}}/cart/coupon" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"code":"NOPE404"}'
# 5.12
curl -i -X POST "{{baseUrl}}/cart/coupon" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"code":""}'
# 5.13
curl -i -X DELETE "{{baseUrl}}/cart/items/{{productId}}" -H "Authorization: Bearer {{customerToken}}"
# 5.14
curl -i -X DELETE "{{baseUrl}}/cart" -H "Authorization: Bearer {{customerToken}}"
# 5.15
curl -i -X POST "{{baseUrl}}/cart/coupon" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"code":"{{couponCode}}"}'
```

---

## 6. Orders and payment (customer)

Needs an address (`addressId`, 2.25). Cases 6.9–6.13 and 6.24 use the **built-in test gateway**: run them with
`STRIPE_SECRET_KEY` empty in `server/.env` (restart the API). With Stripe keys set, orders are paid through the app
instead (card `4242 4242 4242 4242`), and `outcome` is ignored.
⚠ Creates two real orders: A gets cancelled (stock is restocked), B is handed to the vendor in §7.

| # | Case | Expected |
|---|---|---|
| 6.2 | No `Idempotency-Key` header | 400 `Send an Idempotency-Key header (8-100 letters, digits, - or _) with checkout` |
| 6.3 | Key too short (`abc`) | 400 (same message) |
| 6.4 | Empty cart | 400 `Your cart is empty` |
| 6.5 | No address in the body (cart not empty: run 5.2 first) | 400 `address: Choose a delivery address` |
| 6.6 | Unknown `addressId` | 404 `Delivery address not found` |
| 6.7 | **Order A**: run 5.2, then checkout with key `order-a-0001` | 201 `{ order: { _id, orderNumber, pricing }, payment, prefill }` → save `orderA`. The cart is kept until the order is paid (6.12 empties it), so an abandoned payment doesn't lose it |
| 6.8 | Same key again | 201 with the **same** `order._id` (no second order) |
| 6.9 | Payment config for A | 200 payment details (test gateway; with Stripe: `publishableKey` and `clientSecret`) |
| 6.10 | **Order B**: run 5.2, checkout with key `order-b-0001` | 201 → save `orderB` |
| 6.11 | Pay A with a simulated decline | 402 `Payment was declined by the bank (simulated). You can try again.` |
| 6.12 | Pay A, then B | 200 `{ order: { payment: { status: "paid" }, status: "placed" } }` |
| 6.13 | Pay A again | 200 `{ order }` (already paid, nothing changes) |
| 6.14 | Payment config for paid A | 400 `This order is already paid` |
| 6.15 | My orders, filtered | 200 paginated |
| 6.16 | Order A detail | 200 `{ order }` |
| 6.17 | Order A as customer2 | 403 `You can only view your own orders` |
| 6.18 | Order `abc` / unknown | 400 `Invalid order id` / 404 `Order not found` |
| 6.19 | Order A as vendor | 403 `You do not have permission...` |
| 6.20 | Invoice for paid A | 200 PDF (Postman: Send and Download) |
| 6.21 | Invoice for an unpaid order (`GET /orders?status=pending_payment` → `items[0]._id`, skip if none) | 400 `An invoice is generated once the order is paid` |
| 6.22 | Cancel A with `reasonCode: other`, no note | 400 `Describe the reason (at least 3 characters)` |
| 6.23 | Cancel A with an unknown reasonCode | 400 `Invalid enum value. Expected 'changed_mind' \| 'other'...` |
| 6.24 | Cancel A | 200, all packages `cancelled`, stock restocked, `payment.status: "refunded"` (test-gateway refund; with Stripe a real test refund) |
| 6.25 | Cancel A again | 400 `This order is already cancelled` |
| 6.26 | Pay cancelled A | 400 `This order was cancelled` |
| 6.27 | Cancel a shipped order (`GET /orders?status=shipped` → `items[0]._id`) ⚠ only if you accept losing that demo order | 400 `Part of this order has already shipped and can no longer be cancelled` |

```bash
# 6.2
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"addressId":"{{addressId}}"}'
# 6.3
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Idempotency-Key: abc" -H "Content-Type: application/json" -d '{"addressId":"{{addressId}}"}'
# 6.4  (cart empty)
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Idempotency-Key: empty-cart-0001" -H "Content-Type: application/json" -d '{"addressId":"{{addressId}}"}'
# 6.5  (run 5.2 first)
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Idempotency-Key: no-address-0001" -H "Content-Type: application/json" -d '{}'
# 6.6
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Idempotency-Key: bad-address-0001" -H "Content-Type: application/json" -d '{"addressId":"000000000000000000000000"}'
# 6.7  (and 6.8 = send exactly the same request again)
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Idempotency-Key: order-a-0001" -H "Content-Type: application/json" -d '{"addressId":"{{addressId}}"}'
# 6.9
curl -i "{{baseUrl}}/orders/{{orderA}}/payment" -H "Authorization: Bearer {{customerToken}}"
# 6.10  (run 5.2 first)
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Idempotency-Key: order-b-0001" -H "Content-Type: application/json" -d '{"addressId":"{{addressId}}"}'
# 6.11
curl -i -X POST "{{baseUrl}}/orders/{{orderA}}/verify" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"outcome":"failure"}'
# 6.12
curl -i -X POST "{{baseUrl}}/orders/{{orderA}}/verify" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"outcome":"success"}'
curl -i -X POST "{{baseUrl}}/orders/{{orderB}}/verify" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"outcome":"success"}'
# 6.13
curl -i -X POST "{{baseUrl}}/orders/{{orderA}}/verify" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"outcome":"success"}'
# 6.14
curl -i "{{baseUrl}}/orders/{{orderA}}/payment" -H "Authorization: Bearer {{customerToken}}"
# 6.15
curl -i "{{baseUrl}}/orders?status=placed&page=1&limit=5" -H "Authorization: Bearer {{customerToken}}"
# 6.16
curl -i "{{baseUrl}}/orders/{{orderA}}" -H "Authorization: Bearer {{customerToken}}"
# 6.17
curl -i "{{baseUrl}}/orders/{{orderA}}" -H "Authorization: Bearer {{customer2Token}}"
# 6.18
curl -i "{{baseUrl}}/orders/abc" -H "Authorization: Bearer {{customerToken}}"
curl -i "{{baseUrl}}/orders/000000000000000000000000" -H "Authorization: Bearer {{customerToken}}"
# 6.19
curl -i "{{baseUrl}}/orders/{{orderA}}" -H "Authorization: Bearer {{vendorToken}}"
# 6.20
curl -i "{{baseUrl}}/orders/{{orderA}}/invoice" -H "Authorization: Bearer {{customerToken}}" -o invoice-a.pdf
# 6.21
curl -i "{{baseUrl}}/orders/UNPAID_ORDER_ID/invoice" -H "Authorization: Bearer {{customerToken}}"
# 6.22
curl -i -X POST "{{baseUrl}}/orders/{{orderA}}/cancel" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"reasonCode":"other"}'
# 6.23
curl -i -X POST "{{baseUrl}}/orders/{{orderA}}/cancel" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"reasonCode":"fraud"}'
# 6.24  (and 6.25 = send again)
curl -i -X POST "{{baseUrl}}/orders/{{orderA}}/cancel" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"reasonCode":"changed_mind"}'
# 6.26
curl -i -X POST "{{baseUrl}}/orders/{{orderA}}/verify" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"outcome":"success"}'
# 6.27
curl -i -X POST "{{baseUrl}}/orders/SHIPPED_ORDER_ID/cancel" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"reasonCode":"changed_mind"}'
```

---

## 7. Vendor (`/vendor`)

| # | Case | Expected |
|---|---|---|
| 7.1 | Onboard as TechNova (already has a store) | 409 `You already have a store` |
| 7.2 | ⚠ Onboard as newUser | 201 `{ vendor: { status: "pending" } }` → save `newStoreId`. newUser's role becomes `vendor` (log in again if later calls say 403) |
| 7.3 | Onboard with a bad IFSC | 400 `bank.ifsc: Enter a valid IFSC code (e.g. HDFC0001234)` |
| 7.4 | Onboard with a bad GSTIN | 400 `gstin: Enter a valid 15-character GSTIN...` |
| 7.5 | Onboard as admin | 403 `You do not have permission...` |
| 7.6 | My store (TechNova) | 200 `{ vendor }` with masked bank details |
| 7.7 | My store as a customer | 403 |
| 7.8 | Update store `{ tagline }` | 200 `{ vendor }` with the new tagline |
| 7.9 | Change `bank` details without a password | 403 `Enter your account password to change payout details` (`code: PASSWORD_REQUIRED`) |
| 7.10 | Same with a wrong password | 403 `Incorrect password` |
| 7.11 | Pending store (newUser) opens the dashboard | 403 `Your store is pending. You can manage it once an admin approves it.` |
| 7.12 | Dashboard (TechNova) | 200 KPIs, charts, low-stock list |
| 7.13 | My products, filtered and sorted | 200 paginated (`status` = active, inactive, out_of_stock, low_stock; `sort` = newest, price_asc, price_desc, stock, best_selling) |
| 7.14 | Create product | 201 `{ product }` → save `vendorProductId` |
| 7.15 | No images | 400 `images: Add at least one image` |
| 7.16 | MRP below price | 400 `mrp: MRP cannot be lower than the selling price` |
| 7.17 | Category `abc` | 400 `category: Choose a category` |
| 7.18 | Category that doesn't exist (`000000000000000000000000`) | 400 `Unknown category` |
| 7.19 | Same SKU again | 409 `You already have a product with SKU API-TEST-001` |
| 7.20 | Get product / `abc` / another store's product (`otherProductId`) | 200 / 400 `Invalid product id` / 404 `Product not found` |
| 7.21 | Update `{ price, stock }` / `{ mrp: 1 }` | 200 / 400 `MRP cannot be lower than the selling price`. The app sends only changed fields plus `editVersion` and `stockBase` (see 9.9–9.10) |
| 7.22 | Delete product (then GET it) | 200, then 404 (soft delete: admin still sees it, 8.21) |
| 7.23 | Orders `?status=placed` | 200 paginated, includes `orderB` |
| 7.24 | Pack order B | 200, package `packed` |
| 7.25 | Jump B from packed to delivered | 400 `A packed package cannot be moved to delivered` |
| 7.26 | Ship B with a tracking ID, then deliver | 200 `shipped` (trackingId saved), 200 `delivered` |
| 7.27 | Cancel delivered B | 400 `A delivered package cannot be moved to cancelled` |
| 7.27b | Cancel without a reasonCode | 400 `reasonCode: Required` / invalid enum |
| 7.27c | Order `abc` | 400 `Invalid order id` |
| 7.28 | Payouts `?status=on_hold` | 200 paginated |
| 7.29 | Reviews `?replied=no` | 200 → save `vendorReviewId` |
| 7.30 | Reply to it | 200 `{ reply: { text, at } }` |
| 7.31 | Reply `a` (too short) | 400 `text: Write a reply` |
| 7.32 | Reply to an unknown review | 404 `Review not found` |
| 7.33 | Delete the reply | 200 `{ reply: null }` (puts it back as it was) |
| 7.34 | Coupons list | 200 paginated (only this store's coupons) |
| 7.35 | Create coupon `APITEST10` | 201 `{ coupon }` → save `vendorCouponId` |
| 7.36 | Same code again | 409 `Coupon APITEST10 already exists` |
| 7.37 | Code `a!` | 400 `code: Use 3–20 letters, numbers, - or _` |
| 7.38 | Vendor sends `isPublic` | 403 `Only admins can change coupon visibility` |
| 7.39 | Deactivate it | 200 `{ coupon: { isActive: false } }` |
| 7.40 | Delete it (then again) | 200 `Coupon deleted`, then 404 `Coupon not found` |

```bash
# 7.1
curl -i -X POST "{{baseUrl}}/vendor/onboard" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"storeName":"Another Store","email":"store@example.com","phone":"9811111111","address":{"line1":"1 Test Street","city":"Pune","state":"Maharashtra","pincode":"411001"},"bank":{"accountHolder":"Test","accountNumber":"123456789012","ifsc":"HDFC0001234"}}'
# 7.2  (store name and phone must be unique: on 409 change the phone to another 10-digit number starting 6-9)
curl -i -X POST "{{baseUrl}}/vendor/onboard" -H "Authorization: Bearer {{newUserToken}}" -H "Content-Type: application/json" -d '{"storeName":"Postman Test Store {{$timestamp}}","tagline":"Testing","email":"{{newUserEmail}}","phone":"9822000001","address":{"line1":"1 Test Street","city":"Pune","state":"Maharashtra","pincode":"411001"},"bank":{"accountHolder":"Test User","accountNumber":"123456789012","ifsc":"HDFC0001234"}}'
# 7.3
curl -i -X POST "{{baseUrl}}/vendor/onboard" -H "Authorization: Bearer {{newUserToken}}" -H "Content-Type: application/json" -d '{"storeName":"Bad Ifsc Store","email":"x@example.com","phone":"9833333333","address":{"line1":"1 Test Street","city":"Pune","state":"Maharashtra","pincode":"411001"},"bank":{"accountHolder":"Test","accountNumber":"123456789012","ifsc":"BAD"}}'
# 7.4
curl -i -X POST "{{baseUrl}}/vendor/onboard" -H "Authorization: Bearer {{newUserToken}}" -H "Content-Type: application/json" -d '{"storeName":"Bad Gst Store","email":"x@example.com","phone":"9833333333","gstin":"123","address":{"line1":"1 Test Street","city":"Pune","state":"Maharashtra","pincode":"411001"},"bank":{"accountHolder":"Test","accountNumber":"123456789012","ifsc":"HDFC0001234"}}'
# 7.5
curl -i -X POST "{{baseUrl}}/vendor/onboard" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{}'
# 7.6
curl -i "{{baseUrl}}/vendor/store" -H "Authorization: Bearer {{vendorToken}}"
# 7.7
curl -i "{{baseUrl}}/vendor/store" -H "Authorization: Bearer {{customerToken}}"
# 7.8
curl -i -X PATCH "{{baseUrl}}/vendor/store" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"tagline":"Flagship phones, laptops & smart gadgets"}'
# 7.9
curl -i -X PATCH "{{baseUrl}}/vendor/store" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"bank":{"accountHolder":"TechNova Electronics","accountNumber":"123456789012","ifsc":"HDFC0001234"}}'
# 7.10
curl -i -X PATCH "{{baseUrl}}/vendor/store" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"bank":{"accountHolder":"TechNova Electronics","accountNumber":"123456789012","ifsc":"HDFC0001234"},"currentPassword":"wrong-pass"}'
# 7.11
curl -i "{{baseUrl}}/vendor/dashboard" -H "Authorization: Bearer {{newUserToken}}"
# 7.12
curl -i "{{baseUrl}}/vendor/dashboard" -H "Authorization: Bearer {{vendorToken}}"
# 7.13
curl -i "{{baseUrl}}/vendor/products?status=low_stock&sort=price_asc&q=&page=1&limit=5" -H "Authorization: Bearer {{vendorToken}}"
# 7.14
curl -i -X POST "{{baseUrl}}/vendor/products" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"title":"API Test Product","description":"Created from Postman","brand":"TestBrand","category":"{{categoryId}}","price":999,"mrp":1299,"stock":5,"sku":"API-TEST-001","images":[{"url":"https://picsum.photos/600"}],"tags":["test"],"specs":[{"label":"Color","value":"Black"}]}'
# 7.15
curl -i -X POST "{{baseUrl}}/vendor/products" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"title":"No Image Product","category":"{{categoryId}}","price":999,"stock":5,"images":[]}'
# 7.16
curl -i -X POST "{{baseUrl}}/vendor/products" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"title":"Bad Mrp Product","category":"{{categoryId}}","price":999,"mrp":500,"stock":5,"images":[{"url":"https://picsum.photos/600"}]}'
# 7.17
curl -i -X POST "{{baseUrl}}/vendor/products" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"title":"Bad Category","category":"abc","price":999,"stock":5,"images":[{"url":"https://picsum.photos/600"}]}'
# 7.18
curl -i -X POST "{{baseUrl}}/vendor/products" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"title":"Ghost Category","category":"000000000000000000000000","price":999,"stock":5,"images":[{"url":"https://picsum.photos/600"}]}'
# 7.19
curl -i -X POST "{{baseUrl}}/vendor/products" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"title":"Duplicate Sku","category":"{{categoryId}}","price":999,"stock":5,"sku":"API-TEST-001","images":[{"url":"https://picsum.photos/600"}]}'
# 7.20
curl -i "{{baseUrl}}/vendor/products/{{vendorProductId}}" -H "Authorization: Bearer {{vendorToken}}"
curl -i "{{baseUrl}}/vendor/products/abc" -H "Authorization: Bearer {{vendorToken}}"
curl -i "{{baseUrl}}/vendor/products/{{otherProductId}}" -H "Authorization: Bearer {{vendorToken}}"
# 7.21
curl -i -X PATCH "{{baseUrl}}/vendor/products/{{vendorProductId}}" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"price":899,"stock":7}'
curl -i -X PATCH "{{baseUrl}}/vendor/products/{{vendorProductId}}" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"mrp":1}'
# 7.22
curl -i -X DELETE "{{baseUrl}}/vendor/products/{{vendorProductId}}" -H "Authorization: Bearer {{vendorToken}}"
curl -i "{{baseUrl}}/vendor/products/{{vendorProductId}}" -H "Authorization: Bearer {{vendorToken}}"
# 7.23
curl -i "{{baseUrl}}/vendor/orders?status=placed&page=1&limit=5" -H "Authorization: Bearer {{vendorToken}}"
# 7.24
curl -i -X PATCH "{{baseUrl}}/vendor/orders/{{orderB}}/status" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"status":"packed"}'
# 7.25
curl -i -X PATCH "{{baseUrl}}/vendor/orders/{{orderB}}/status" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"status":"delivered"}'
# 7.26
curl -i -X PATCH "{{baseUrl}}/vendor/orders/{{orderB}}/status" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"status":"shipped","trackingId":"TRK123456789"}'
curl -i -X PATCH "{{baseUrl}}/vendor/orders/{{orderB}}/status" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"status":"delivered"}'
# 7.27
curl -i -X PATCH "{{baseUrl}}/vendor/orders/{{orderB}}/status" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"status":"cancelled","reasonCode":"out_of_stock"}'
# 7.27b
curl -i -X PATCH "{{baseUrl}}/vendor/orders/{{orderB}}/status" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"status":"cancelled"}'
# 7.27c
curl -i -X PATCH "{{baseUrl}}/vendor/orders/abc/status" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"status":"packed"}'
# 7.28
curl -i "{{baseUrl}}/vendor/payouts?status=on_hold&page=1" -H "Authorization: Bearer {{vendorToken}}"
# 7.29
curl -i "{{baseUrl}}/vendor/reviews?replied=no&page=1&limit=5" -H "Authorization: Bearer {{vendorToken}}"
# 7.30
curl -i -X PUT "{{baseUrl}}/vendor/reviews/{{vendorReviewId}}/reply" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"text":"Thank you for the feedback!"}'
# 7.31
curl -i -X PUT "{{baseUrl}}/vendor/reviews/{{vendorReviewId}}/reply" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"text":"a"}'
# 7.32
curl -i -X PUT "{{baseUrl}}/vendor/reviews/000000000000000000000000/reply" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"text":"Thanks!"}'
# 7.33
curl -i -X DELETE "{{baseUrl}}/vendor/reviews/{{vendorReviewId}}/reply" -H "Authorization: Bearer {{vendorToken}}"
# 7.34
curl -i "{{baseUrl}}/vendor/coupons" -H "Authorization: Bearer {{vendorToken}}"
# 7.35  (and 7.36 = send again)
curl -i -X POST "{{baseUrl}}/vendor/coupons" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"code":"APITEST10","description":"Postman test","type":"percent","value":10,"minOrder":500,"maxDiscount":200}'
# 7.37
curl -i -X POST "{{baseUrl}}/vendor/coupons" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"code":"a!","type":"flat","value":50}'
# 7.38
curl -i -X POST "{{baseUrl}}/vendor/coupons" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"code":"APITEST20","type":"flat","value":50,"isPublic":false}'
# 7.39
curl -i -X PATCH "{{baseUrl}}/vendor/coupons/{{vendorCouponId}}" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"isActive":false}'
# 7.40  (send twice)
curl -i -X DELETE "{{baseUrl}}/vendor/coupons/{{vendorCouponId}}" -H "Authorization: Bearer {{vendorToken}}"
```

---

## 8. Admin (`/admin`)

| # | Case | Expected |
|---|---|---|
| 8.1 | Analytics `range=7` | 200 `{ range: 7, kpis, series, ... }` |
| 8.2 | Analytics `range=12` | 200, falls back to 30 days |
| 8.3 | Any admin route as a customer / with no token | 403 / 401 |
| 8.4 | Vendors `?status=pending` | 200 paginated + `counts`; **no** `bank`, `stripe`, `payoutChanges`; has `payoutLinked` |
| 8.5 | Users `?role=vendor&q=tech` | 200 paginated + `counts` |
| 8.6 | Users `?q={{newUserEmail}}` | 200 → save `newUserId` |
| 8.7 | Approve new store (`pending → approved`) | 200 `{ vendor: { status: "approved" } }`, no payout fields |
| 8.8 | `approved → rejected` | 400 `An approved store cannot be moved to rejected (allowed: suspended)` |
| 8.9 | `status: "pending"` | 400 `status: Invalid enum value...` |
| 8.10 | Suspend without a reason | 400 `Give a reason when a store is suspended` |
| 8.11 | Admin sends payout details (`bank`) | 400 `Unrecognized key(s) in object: 'bank'` |
| 8.12 | Vendor id `abc` / unknown | 400 `Invalid _id` / 404 `Vendor not found` |
| 8.13 | ⚠ Block newUser (store owner) | 200 `{ user: { status: "blocked" }, store: { status: "suspended", changed: true } }`; `GET /stores/{{newStoreId}}` → 404 |
| 8.13a | As newUser after the block: `GET /auth/me` (old token), `POST /auth/login`, then `GET /categories` with the returned cookie | each 403 `Your account has been blocked. Please contact support.`, `details: { code: "ACCOUNT_BLOCKED", reason }`; the first answer sets `vendora_blocked`, and with it even public routes answer 403 |
| 8.13b | Approve that store while the owner is blocked | 400 `The store owner's account is blocked. Unblock the user first` |
| 8.13c | Unblock newUser | 200 `store: { status: "approved", changed: true }`; newUser's next request clears `vendora_blocked` and works again (log in) |
| 8.13d | Block without a reason / block an admin / change yourself | 400 `reason: Give a reason for blocking this user` / 400 `Admin accounts cannot be blocked` / 400 `You cannot change your own account here` |
| 8.14 | Orders, `fulfilment=placed` | 200 rows → save `adminOrderId`, `adminPackageId` |
| 8.15 | Orders, search and filters (several) | 200; see the table under the curls |
| 8.16 | Orders with bad filters | 400 with a clear message each |
| 8.17 | Orders summary `range=30` / `from&to` | 200 KPIs (orders, sales, packages, payments, refunds, cancellationRate, avgFulfilmentHours, delayed, exceptions, vendorPerformance) |
| 8.18 | Export CSV | 200 `text/csv`, headers `X-Total-Count`, `X-Total-Pages`; no customer name, email or address |
| 8.19 | Order detail / invoice for `{{orderB}}` | 200 `{ order }` / 200 PDF |
| 8.20 | Package update | ⚠ `packed` → 200; cancel without reasonCode → 400; delivered package `{{orderB}}` cancel → 400 `A delivered package cannot be moved to cancelled`; unknown package → 404 `Package not found` |
| 8.21 | Products `?status=deleted` | 200, includes the product deleted in 7.22 with `deletedAt` |
| 8.22 | Remove a product without a reason | 400 `reason: Give a reason for removing this product` |
| 8.23 | ⚠ Remove `{{productId}}`, then approve it again | 200 `moderation.status: "removed"` (public `GET /products/{{productId}}` → 404), then 200 `approved` (back to 200) |
| 8.24 | Reviews queue `?status=visible&q=good` | 200 paginated with author `email` |
| 8.25 | Moderate review `abc` / unknown | 400 `Invalid review id` / 404 `Review not found` |
| 8.26 | Categories (admin) | 200 `{ categories (with productCount), groups }` |
| 8.27 | Create category | 201 `{ category }` → save `adminCategoryId` |
| 8.28 | Same name again (any case) | 409 `A category named "..." already exists` |
| 8.29 | Bad group / name `a` | 400 `group: Invalid enum value...` / 400 `name: Name must be at least 2 characters` |
| 8.30 | Update `{ order: 5 }` / `{}` | 200 `{ category, affectedProducts }` / 400 `Nothing to update` |
| 8.31 | Delete (then again) | 200 `{ deleted: true, hiddenProducts: 0 }`, then 404 `Category not found` |
| 8.32 | Coupons `?scope=all` | 200 paginated, platform and store coupons |
| 8.33 | Create a private platform coupon | 201 `{ coupon: { isPublic: false, vendor: null } }` → save `adminCouponId`; it is **not** in `GET /coupons` |
| 8.34 | Update it `{ isPublic: true }` | 200, now listed in `GET /coupons` |
| 8.35 | Delete it | 200 `Coupon deleted` |
| 8.36 | Settings | 200 `{ settings, history }` |
| 8.37 | Patch settings with the current `shippingFee` | 200 `{ settings }` |
| 8.38 | `{}` / `commissionRate: 60` | 400 `Send at least one setting to change` / 400 `commissionRate: ...less than or equal to 50` |
| 8.39 | Old `PUT /admin/settings` | 404 `Route not found` |
| 8.40 | System | 200 database, cache, search, storage and payment status |
| 8.41 | Reindex | 200 `{ message, count }`; 409 while another reindex runs; 400 if Elasticsearch isn't connected |

```bash
# 8.1
curl -i "{{baseUrl}}/admin/analytics?range=7" -H "Authorization: Bearer {{adminToken}}"
# 8.2
curl -i "{{baseUrl}}/admin/analytics?range=12" -H "Authorization: Bearer {{adminToken}}"
# 8.3
curl -i "{{baseUrl}}/admin/analytics" -H "Authorization: Bearer {{customerToken}}"
curl -i "{{baseUrl}}/admin/analytics"
# 8.4
curl -i "{{baseUrl}}/admin/vendors?status=pending&page=1" -H "Authorization: Bearer {{adminToken}}"
# 8.5
curl -i "{{baseUrl}}/admin/users?role=vendor&q=tech" -H "Authorization: Bearer {{adminToken}}"
# 8.6
curl -i "{{baseUrl}}/admin/users?q={{newUserEmail}}" -H "Authorization: Bearer {{adminToken}}"
# 8.7
curl -i -X PATCH "{{baseUrl}}/admin/vendors/{{newStoreId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"approved"}'
# 8.8
curl -i -X PATCH "{{baseUrl}}/admin/vendors/{{newStoreId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"rejected","rejectionReason":"testing the flow"}'
# 8.9
curl -i -X PATCH "{{baseUrl}}/admin/vendors/{{newStoreId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"pending"}'
# 8.10
curl -i -X PATCH "{{baseUrl}}/admin/vendors/{{newStoreId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"suspended"}'
# 8.11
curl -i -X PATCH "{{baseUrl}}/admin/vendors/{{newStoreId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"bank":{"accountHolder":"Hacker","accountNumber":"999999999999","ifsc":"HDFC0001234"}}'
# 8.12
curl -i -X PATCH "{{baseUrl}}/admin/vendors/abc" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"commissionRate":5}'
curl -i -X PATCH "{{baseUrl}}/admin/vendors/000000000000000000000000" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"commissionRate":5}'
# 8.13
curl -i -X PATCH "{{baseUrl}}/admin/users/{{newUserId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"blocked","reason":"Postman block test"}'
curl -i "{{baseUrl}}/stores/{{newStoreId}}"
# 8.13b
curl -i -X PATCH "{{baseUrl}}/admin/vendors/{{newStoreId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"approved"}'
# 8.13c
curl -i -X PATCH "{{baseUrl}}/admin/users/{{newUserId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"active"}'
# 8.13d  (ADMIN_USER_ID = your own admin _id from GET /auth/me with adminToken)
curl -i -X PATCH "{{baseUrl}}/admin/users/{{newUserId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"blocked"}'
curl -i -X PATCH "{{baseUrl}}/admin/users/ADMIN_USER_ID" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"blocked","reason":"self"}'
# 8.14
curl -i "{{baseUrl}}/admin/orders?fulfilment=placed&limit=1" -H "Authorization: Bearer {{adminToken}}"
# 8.15
curl -i "{{baseUrl}}/admin/orders?q=TechNova&page=1&limit=5" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?attention=all" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?vendor={{storeId}}&fulfilment=shipped&sort=total_desc" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?refund=any&payment=refunded" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?from=2026-10-01&to=2026-10-31&minTotal=1000&maxTotal=50000" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?range=today&delayed=true" -H "Authorization: Bearer {{adminToken}}"
# 8.16
curl -i "{{baseUrl}}/admin/orders?status=bogus" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?vendor=abc" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?from=29-10-2026" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?minTotal=500&maxTotal=100" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?sort=random" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?attention=nope" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders?range=12" -H "Authorization: Bearer {{adminToken}}"
# 8.17
curl -i "{{baseUrl}}/admin/orders/summary?range=30" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders/summary?from=2026-10-01&to=2026-10-31" -H "Authorization: Bearer {{adminToken}}"
# 8.18
curl -i "{{baseUrl}}/admin/orders/export?refund=any" -H "Authorization: Bearer {{adminToken}}" -o orders.csv
# 8.19
curl -i "{{baseUrl}}/admin/orders/{{orderB}}" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/orders/{{orderB}}/invoice" -H "Authorization: Bearer {{adminToken}}" -o invoice-b.pdf
# 8.20
curl -i -X PATCH "{{baseUrl}}/admin/orders/{{adminOrderId}}/packages/{{adminPackageId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"packed"}'
curl -i -X PATCH "{{baseUrl}}/admin/orders/{{adminOrderId}}/packages/{{adminPackageId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"cancelled"}'
curl -i -X PATCH "{{baseUrl}}/admin/orders/{{orderB}}/packages/ORDER_B_PACKAGE_ID" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"cancelled","reasonCode":"fraud"}'
curl -i -X PATCH "{{baseUrl}}/admin/orders/{{adminOrderId}}/packages/000000000000000000000000" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"packed"}'
# 8.21
curl -i "{{baseUrl}}/admin/products?status=deleted" -H "Authorization: Bearer {{adminToken}}"
# 8.22
curl -i -X PATCH "{{baseUrl}}/admin/products/{{productId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"removed"}'
# 8.23
curl -i -X PATCH "{{baseUrl}}/admin/products/{{productId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"removed","reason":"Postman moderation test"}'
curl -i "{{baseUrl}}/products/{{productId}}"
curl -i -X PATCH "{{baseUrl}}/admin/products/{{productId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"approved"}'
# 8.24
curl -i "{{baseUrl}}/admin/reviews?status=visible&q=good&page=1" -H "Authorization: Bearer {{adminToken}}"
# 8.25
curl -i -X PATCH "{{baseUrl}}/admin/reviews/abc" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"visible"}'
curl -i -X PATCH "{{baseUrl}}/admin/reviews/000000000000000000000000" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"visible"}'
# 8.26
curl -i "{{baseUrl}}/admin/categories" -H "Authorization: Bearer {{adminToken}}"
# 8.27  (and 8.28 = send again)
curl -i -X POST "{{baseUrl}}/admin/categories" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"name":"Postman Test Category","group":"General","order":99}'
# 8.29
curl -i -X POST "{{baseUrl}}/admin/categories" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"name":"Bad Group","group":"Toys"}'
curl -i -X POST "{{baseUrl}}/admin/categories" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"name":"a"}'
# 8.30
curl -i -X PATCH "{{baseUrl}}/admin/categories/{{adminCategoryId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"order":5}'
curl -i -X PATCH "{{baseUrl}}/admin/categories/{{adminCategoryId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{}'
# 8.31  (send twice)
curl -i -X DELETE "{{baseUrl}}/admin/categories/{{adminCategoryId}}" -H "Authorization: Bearer {{adminToken}}"
# 8.32
curl -i "{{baseUrl}}/admin/coupons?scope=all&page=1" -H "Authorization: Bearer {{adminToken}}"
# 8.33
curl -i -X POST "{{baseUrl}}/admin/coupons" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"code":"ADMINTEST50","description":"Private platform coupon","type":"flat","value":50,"minOrder":300,"isPublic":false}'
curl -i "{{baseUrl}}/coupons"
# 8.34
curl -i -X PATCH "{{baseUrl}}/admin/coupons/{{adminCouponId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"isPublic":true}'
# 8.35
curl -i -X DELETE "{{baseUrl}}/admin/coupons/{{adminCouponId}}" -H "Authorization: Bearer {{adminToken}}"
# 8.36
curl -i "{{baseUrl}}/admin/settings" -H "Authorization: Bearer {{adminToken}}"
# 8.37  (use the current shippingFee from 8.36)
curl -i -X PATCH "{{baseUrl}}/admin/settings" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"shippingFee":49}'
# 8.38
curl -i -X PATCH "{{baseUrl}}/admin/settings" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{}'
curl -i -X PATCH "{{baseUrl}}/admin/settings" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"commissionRate":60}'
# 8.39
curl -i -X PUT "{{baseUrl}}/admin/settings" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"shippingFee":49}'
# 8.40
curl -i "{{baseUrl}}/admin/system" -H "Authorization: Bearer {{adminToken}}"
# 8.41
curl -i -X POST "{{baseUrl}}/admin/search/reindex" -H "Authorization: Bearer {{adminToken}}"
```

**8.15 / 8.16 expected:** every 8.15 call returns 200 with rows that match the filter (`total` shrinks as
filters combine). The 8.16 calls return 400 with, in order: `status must be one of: ...`, `Invalid vendor id`,
`from and to must be dates like 2026-10-29`, `minTotal must not be greater than maxTotal`,
`sort must be one of: newest, oldest, total_desc, total_asc`, `attention must be one of: ...`,
`range must be today, 7, 30, 90, 365 or all`.

---

## 9. Live updates and race conditions

Most of these need two terminals (or two Postman tabs): one holding the event stream, one making the change.
Restore what you change afterwards (stock, coupon, visibility).

| # | Case | Expected |
|---|---|---|
| 9.1 | `GET /cart/events` without a token | 401 |
| 9.2 | `GET /cart/events` as the customer (keep it open) | 200 `text/event-stream`, first event `event: ready` |
| 9.3 | Keep 9.2 open, put `{{productId}}` in the cart, then as the vendor change its stock | the stream receives `event: cart` with `{"productId": ...}` within about a second; `GET /cart` shows the new stock |
| 9.4 | Keep 9.2 open; as the vendor switch a coupon off, then on | `event: coupon` for each change; `GET /coupons` no longer lists it while off |
| 9.5 | Checkout with a wrong `expectedTotal` (e.g. 1) | 409 `CART_CHANGED` `Your total changed from ₹1 to ₹X...`; no order is created |
| 9.6 | Put `{{productId}}` in the cart, hide it as the vendor (`isActive: false`), then checkout **without** reading the cart first | 409 `CART_CHANGED` `No longer available: ...`; turn it visible again |
| 9.7 | Send two checkouts at the same moment (two terminals, different `Idempotency-Key`s) | one 201; the other 409 `A checkout is already in progress (maybe in another tab)...` or 400 `Your cart is empty` |
| 9.8 | Post the same review twice (4.10's request) | 201, then 409 `You just posted this review` |
| 9.9 | Vendor: `PATCH /vendor/products/{{productId}}` with `stock` and a `stockBase` that is not the current stock | 409 `STOCK_CHANGED` `Stock changed from X to Y since you opened this form...`, `details.stock` = current stock; nothing saved |
| 9.10 | Vendor: same PATCH with an old `editVersion` (read it with `GET /vendor/products/{{productId}}`, then save twice with that value) | first 200, second 409 `PRODUCT_CHANGED` |
| 9.11 | Admin: suspend a store that has paid, unshipped orders (TechNova) without `openOrders` | 409 `OPEN_ORDERS` `This store has N paid orders not shipped yet...`; the store stays approved |
| 9.12 | Admin: block that store's owner without `openOrders` | the same 409 `OPEN_ORDERS`; nothing changes |
| 9.13 | `openOrders: "maybe"` | 400 `openOrders: Invalid enum value. Expected 'cancel' \| 'keep'...` |
| 9.14 | Vendor or admin token on `GET /cart` | 403 `You do not have permission to perform this action` |
| 9.15 | Open `GET /cart/events` 6 times at once with the same customer token | five 200 streams, the 6th 429 `Too many open live connections...` |
| 9.16 | Shopper store search by a seller's phone or GSTIN (`GET /stores?q=<phone>`); the same as admin (`GET /admin/vendors?q=<phone>`) | shoppers: `total: 0` (private fields aren't searchable); admin: the store (by phone or GSTIN, any letter case) |
| 9.17 | `GET /auth/status` with a token / without / after "log out of all devices" | 200 `{ ok: true }` / 401 / 401 (the app then shows the signed-out home page) |
| 9.18 | Typos in every search box: `GET /stores?q=teknova`, `/admin/vendors?q=frescart`, `/admin/users?q=anaya`, `/admin/products?q=iphon`, `/vendor/products?q=samsng` | the right store, user or products first (Elasticsearch); with Elasticsearch stopped the same lists still answer (MongoDB text match) |

```bash
# 9.1
curl -i "{{baseUrl}}/cart/events"
# 9.2  (keep this terminal open; -N disables buffering)
curl -N "{{baseUrl}}/cart/events" -H "Authorization: Bearer {{customerToken}}"
# 9.3  (in a second terminal)
curl -i -X POST "{{baseUrl}}/cart/items" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"productId":"{{productId}}","quantity":1}'
curl -i -X PATCH "{{baseUrl}}/vendor/products/{{productId}}" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"stock":NEW_STOCK}'
# 9.4
curl -i -X PATCH "{{baseUrl}}/vendor/coupons/{{vendorCouponId}}" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"isActive":false}'
curl -i -X PATCH "{{baseUrl}}/vendor/coupons/{{vendorCouponId}}" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"isActive":true}'
# 9.5
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Idempotency-Key: total-check-0001" -H "Content-Type: application/json" -d '{"addressId":"{{addressId}}","expectedTotal":1}'
# 9.6
curl -i -X PATCH "{{baseUrl}}/vendor/products/{{productId}}" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"isActive":false}'
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Idempotency-Key: removed-check-0001" -H "Content-Type: application/json" -d '{"addressId":"{{addressId}}"}'
curl -i -X PATCH "{{baseUrl}}/vendor/products/{{productId}}" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"isActive":true}'
# 9.7  (run both lines at the same moment, one per terminal)
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Idempotency-Key: tab-one-0001" -H "Content-Type: application/json" -d '{"addressId":"{{addressId}}"}'
curl -i -X POST "{{baseUrl}}/orders/checkout" -H "Authorization: Bearer {{customerToken}}" -H "Idempotency-Key: tab-two-0001" -H "Content-Type: application/json" -d '{"addressId":"{{addressId}}"}'
# 9.8  (send twice)
curl -i -X POST "{{baseUrl}}/products/{{deliveredProductId}}/reviews" -H "Authorization: Bearer {{customerToken}}" -H "Content-Type: application/json" -d '{"title":"Race test","comment":"Posting this review twice on purpose."}'
# 9.9
curl -i -X PATCH "{{baseUrl}}/vendor/products/{{productId}}" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"stock":999,"stockBase":1}'
# 9.10  (EDIT_VERSION = product.editVersion from GET /vendor/products/{{productId}}; send twice)
curl -i -X PATCH "{{baseUrl}}/vendor/products/{{productId}}" -H "Authorization: Bearer {{vendorToken}}" -H "Content-Type: application/json" -d '{"isActive":true,"editVersion":EDIT_VERSION}'
# 9.11
curl -i -X PATCH "{{baseUrl}}/admin/vendors/{{storeId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"suspended","rejectionReason":"race test"}'
# 9.12  (TECHNOVA_OWNER_ID = vendor.user from GET /admin/vendors?q=TechNova)
curl -i -X PATCH "{{baseUrl}}/admin/users/TECHNOVA_OWNER_ID" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"blocked","reason":"race test"}'
# 9.13
curl -i -X PATCH "{{baseUrl}}/admin/vendors/{{storeId}}" -H "Authorization: Bearer {{adminToken}}" -H "Content-Type: application/json" -d '{"status":"suspended","rejectionReason":"x","openOrders":"maybe"}'
# 9.14
curl -i "{{baseUrl}}/cart" -H "Authorization: Bearer {{vendorToken}}"
curl -i "{{baseUrl}}/cart" -H "Authorization: Bearer {{adminToken}}"
# 9.15  (run 6 times at once, e.g. 6 terminals)
curl -N "{{baseUrl}}/cart/events" -H "Authorization: Bearer {{customerToken}}"
# 9.16  (SELLER_PHONE from GET /admin/vendors -> items[0].phone)
curl -i "{{baseUrl}}/stores?q=SELLER_PHONE"
curl -i "{{baseUrl}}/admin/vendors?q=SELLER_PHONE" -H "Authorization: Bearer {{adminToken}}"
# 9.17
curl -i "{{baseUrl}}/auth/status" -H "Authorization: Bearer {{customerToken}}"
curl -i "{{baseUrl}}/auth/status"
# 9.18
curl -i "{{baseUrl}}/stores?q=teknova"
curl -i "{{baseUrl}}/admin/vendors?q=frescart" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/users?q=anaya" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/admin/products?q=iphon" -H "Authorization: Bearer {{adminToken}}"
curl -i "{{baseUrl}}/vendor/products?q=samsng" -H "Authorization: Bearer {{vendorToken}}"
```

## Covered elsewhere
- **Stripe card payments, webhooks, Connect payouts:** through the app with test cards and `stripe listen` (README →
  *Stripe setup*); refund retry, reconciliation and payout reversal are covered by `pnpm --dir server test`.
- **Returns and the Refunds card:** customer → order page → *Return items*; vendor/admin → *Returns*. Concurrency
  (double requests, payout races) is covered by `test/returns.test.ts`.
- **Redis, S3, Elasticsearch:** `pnpm --dir server redis:check`, `s3:check`, `es:check` (live), plus unit tests for
  failover, uploads and search.
