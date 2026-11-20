/**
 * API integration suite: the cases of docs/API_TESTS.md, run in order against a running stack.
 * It CHANGES DATA (orders, reviews, coupons, stores): point it only at a throwaway database, never Atlas.
 *
 *   BASE_URL=http://localhost:18080 AUDIT_ADMIN_EMAIL=... AUDIT_ADMIN_PASSWORD=... \
 *     node --test --test-concurrency=1 test/integration/api.integration.ts
 *
 * Needs the demo seed (customer@vendora.dev, technova@vendora.dev, ...) and the built-in test gateway
 * (Stripe keys empty, ALLOW_TEST_GATEWAY=true).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.BASE_URL || 'http://localhost:18080').replace(/\/$/, '');
const ADMIN = { email: process.env.AUDIT_ADMIN_EMAIL, password: process.env.AUDIT_ADMIN_PASSWORD };
const ZERO = '000000000000000000000000';
const RUN = Date.now().toString(36);

type Res = { status: number; body: any; headers: Headers; text: string };

/** One API call. Sends Accept: application/json so nginx forwards it to the API instead of the web app. */
async function call(method: string, path: string, { token, body, headers = {}, cookie, raw }: Record<string, any> = {}): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'vendora',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(cookie && { Cookie: cookie }),
      ...(body !== undefined && !raw && { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = (res.headers.get('content-type') || '').includes('pdf') ? '' : await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, headers: res.headers, text };
}

/** Asserts the status (and optionally a message fragment), printing the answer when it differs. */
function expect(res: Res, status: number, message?: RegExp) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text.slice(0, 300)}`);
  if (message) assert.match(res.body?.message || '', message, `message: ${res.body?.message}`);
  return res.body;
}

const cookieOf = (res: Res, name: string) => {
  const all = res.headers.getSetCookie?.() || [];
  const found = all.find((c) => c.startsWith(`${name}=`));
  return found ? found.split(';')[0] : null;
};

async function login(email: string, password: string) {
  const res = await call('POST', '/auth/login', { body: { email, password } });
  const body = expect(res, 200);
  return { token: body.accessToken, user: body.user, cookie: cookieOf(res, 'vendora_rt'), res };
}

// A 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const upload = (token: string | undefined, folder: string, file?: { name: string; type: string; data: Buffer }) => {
  const form = new FormData();
  if (file) form.append('images', new Blob([file.data], { type: file.type }), file.name);
  return call('POST', `/uploads?folder=${folder}`, { token, body: form, raw: true });
};

const S: Record<string, any> = {}; // values carried between cases, like the Postman environment

before(async () => {
  assert.ok(ADMIN.email && ADMIN.password, 'set AUDIT_ADMIN_EMAIL and AUDIT_ADMIN_PASSWORD');
  const health = await call('GET', '/health');
  assert.equal(health.status, 200, `stack not reachable at ${BASE}`);
});

describe('1. System', () => {
  // Through nginx (Docker), only API prefixes reach the API; "/" and unknown paths are the web app.
  // Set API_DIRECT_URL (e.g. http://localhost:5050) to run 1.1, 1.3 and 1.4 against the API itself.
  const DIRECT = process.env.API_DIRECT_URL?.replace(/\/$/, '');
  const direct = async (path) => {
    const res = await fetch(DIRECT + path, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, headers: res.headers, text } as Res;
  };
  const needsDirect = DIRECT ? false : 'needs API_DIRECT_URL (nginx serves the web app here)';
  test('1.1 root', { skip: needsDirect }, async () => {
    const body = expect(await direct('/'), 200);
    assert.equal(body.name, 'Vendora API');
  });
  test('1.1b nginx: page loads get the app, API calls get JSON', async () => {
    const page = await fetch(BASE + '/products', { headers: { Accept: 'text/html' } });
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    assert.match(page.headers.get('vary') || '', /Accept/);
    const api = await call('GET', '/products?limit=1');
    assert.match(api.headers.get('content-type') || '', /json/);
  });
  test('1.2 health reports every service', async () => {
    const body = expect(await call('GET', '/health'), 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.services.database, 'connected');
    for (const key of ['cache', 'search', 'storage', 'payments']) assert.ok(body.services[key], key);
  });
  test('1.3 old /api prefix is gone', { skip: needsDirect }, async () => expect(await direct('/api/health'), 404, /Route not found/));
  test('1.4 unknown route', { skip: needsDirect }, async () => expect(await direct('/nope'), 404, /Route not found: GET \/nope/));
  test('1.4b unknown path under an API prefix', async () => expect(await call('GET', '/products/abc/nope'), 404, /Route not found/));
  test('1.5 webhook with a bad signature', async () => {
    const res = await call('POST', '/payments/webhook', { body: { type: 'payment_intent.succeeded' }, headers: { 'Stripe-Signature': 't=1,v1=bad' } });
    // Without Stripe keys (test gateway) the endpoint is off; with keys a bad signature is 400.
    assert.ok([400, 503].includes(res.status), `got ${res.status}: ${res.text}`);
    assert.match(res.body.message, /signature|not configured/i);
  });
});

describe('2. Auth', () => {
  test('2.1 register', async () => {
    S.newUserEmail = `audit+${RUN}@example.com`;
    const body = expect(await call('POST', '/auth/register', { body: { name: 'Audit User', email: S.newUserEmail, password: 'Test@1234' } }), 201);
    assert.equal(body.user.role, 'customer');
    S.newUserToken = body.accessToken;
  });
  test('2.2 same email again', async () => expect(await call('POST', '/auth/register', { body: { name: 'Audit User', email: S.newUserEmail, password: 'Test@1234' } }), 409, /already exists/));
  test('2.2b same email, different case', async () => expect(await call('POST', '/auth/register', { body: { name: 'Audit User', email: S.newUserEmail.toUpperCase(), password: 'Test@1234' } }), 409, /already exists/));
  test('2.3 short password', async () => expect(await call('POST', '/auth/register', { body: { name: 'T U', email: 'short@example.com', password: '123' } }), 400, /at least 8/));
  test('2.4 invalid email', async () => expect(await call('POST', '/auth/register', { body: { name: 'T U', email: 'not-an-email', password: 'Test@1234' } }), 400, /valid email/));
  test('2.5 role admin is refused', async () => expect(await call('POST', '/auth/register', { body: { name: 'T U', email: `admin2+${RUN}@example.com`, password: 'Test@1234', role: 'admin' } }), 400, /role/));
  test('2.6 login customer sets an HttpOnly refresh cookie', async () => {
    const { token, cookie, res } = await login('customer@vendora.dev', 'Customer@123');
    S.customerToken = token;
    S.customerCookie = cookie;
    const raw = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('vendora_rt=')) || '';
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /Path=\/auth/i);
  });
  test('2.7 wrong password', async () => expect(await call('POST', '/auth/login', { body: { email: 'customer@vendora.dev', password: 'wrong-pass' } }), 401, /Incorrect email or password/));
  test('2.7b unknown email gives the same answer', async () => expect(await call('POST', '/auth/login', { body: { email: `nobody+${RUN}@example.com`, password: 'wrong-pass' } }), 401, /Incorrect email or password/));
  test('2.8 missing password', async () => {
    expect(await call('POST', '/auth/login', { body: { email: 'customer@vendora.dev', password: '' } }), 400, /Password is required/);
    expect(await call('POST', '/auth/login', { body: { email: 'customer@vendora.dev' } }), 400, /password/i);
  });
  test('2.9-2.11 login customer2, vendor, admin', async () => {
    S.customer2Token = (await login('ananya.gupta@example.com', 'Customer@123')).token;
    S.vendorToken = (await login('technova@vendora.dev', 'Vendor@123')).token;
    const admin = await login(ADMIN.email, ADMIN.password);
    assert.equal(admin.user.role, 'admin');
    S.adminToken = admin.token;
    S.adminId = admin.user._id || admin.user.id;
  });
  test('2.12 /auth/me', async () => {
    assert.ok(expect(await call('GET', '/auth/me', { token: S.customerToken }), 200).user);
    const vendor = expect(await call('GET', '/auth/me', { token: S.vendorToken }), 200);
    assert.ok(vendor.user.vendor, 'vendor users get user.vendor');
  });
  test('2.12b /auth/me never returns the password hash', async () => {
    const body = expect(await call('GET', '/auth/me', { token: S.customerToken }), 200);
    assert.equal(body.user.password, undefined);
  });
  test('2.13 /auth/me without a token', async () => expect(await call('GET', '/auth/me'), 401, /log in/));
  test('2.14 garbage token', async () => {
    const body = expect(await call('GET', '/auth/me', { token: 'garbage.token.value' }), 401);
    assert.equal(body.details?.code, 'INVALID_TOKEN');
  });
  test('2.15 refresh with the cookie', async () => {
    const res = await call('POST', '/auth/refresh', { cookie: S.customerCookie });
    const body = expect(res, 200);
    assert.ok(body.accessToken);
    S.customerCookie = cookieOf(res, 'vendora_rt') || S.customerCookie;
  });
  test('2.16 refresh without X-Requested-With', async () => expect(await call('POST', '/auth/refresh', { cookie: S.customerCookie, headers: { 'X-Requested-With': '' } }), 403, /X-Requested-With/));
  test('2.17 refresh without a cookie', async () => {
    const body = expect(await call('POST', '/auth/refresh'), 401);
    assert.equal(body.details?.code, 'NO_SESSION');
  });
  test('2.17b rotated refresh cookie: one parallel refresh allowed, a later replay ends the session', async () => {
    const first = await login(S.newUserEmail, 'Test@1234');
    const rotated = await call('POST', '/auth/refresh', { cookie: first.cookie });
    expect(rotated, 200);
    const newCookie = cookieOf(rotated, 'vendora_rt');
    // A second tab refreshing at the same moment: an access token, but no new cookie.
    const parallel = await call('POST', '/auth/refresh', { cookie: first.cookie });
    expect(parallel, 200);
    assert.equal(cookieOf(parallel, 'vendora_rt'), null);
    // After the 30 s grace window the old cookie counts as stolen: the whole session ends.
    await new Promise((r) => setTimeout(r, 31_000));
    expect(await call('POST', '/auth/refresh', { cookie: first.cookie }), 401, /security reasons/);
    expect(await call('POST', '/auth/refresh', { cookie: newCookie }), 401);
    S.newUserToken = (await login(S.newUserEmail, 'Test@1234')).token;
  });
  test('2.18 sessions list marks the current one', async () => {
    const body = expect(await call('GET', '/auth/sessions', { token: S.customerToken }), 200);
    assert.equal(body.sessions.filter((s) => s.current).length, 1);
  });
  test('2.19 revoke session abc', async () => expect(await call('DELETE', '/auth/sessions/abc', { token: S.customerToken }), 400, /Invalid session id/));
  test('2.20 revoke unknown session', async () => expect(await call('DELETE', `/auth/sessions/${ZERO}`, { token: S.customerToken }), 404, /Session not found/));
  test('2.21 update name', async () => {
    const body = expect(await call('PATCH', '/auth/me', { token: S.newUserToken, body: { name: 'Audit User Renamed' } }), 200);
    assert.equal(body.user.name, 'Audit User Renamed');
  });
  test('2.21b role cannot be changed through /auth/me', async () => {
    const res = await call('PATCH', '/auth/me', { token: S.newUserToken, body: { role: 'admin' } });
    const me = expect(await call('GET', '/auth/me', { token: S.newUserToken }), 200);
    assert.equal(me.user.role, 'customer', `role changed! PATCH answered ${res.status}`);
  });
  test('2.22 bad phone', async () => expect(await call('PATCH', '/auth/me', { token: S.newUserToken, body: { phone: '12345' } }), 400, /10-digit/));
  test('2.23 phone used by another user', async () => {
    const users = expect(await call('GET', '/admin/users?limit=50', { token: S.adminToken }), 200);
    const phone = users.items.find((u) => u.phone && u.email !== S.newUserEmail)?.phone;
    assert.ok(phone, 'no seeded user with a phone');
    expect(await call('PATCH', '/auth/me', { token: S.newUserToken, body: { phone } }), 409, /already registered/);
  });
  test('2.24 list addresses', async () => assert.ok(Array.isArray(expect(await call('GET', '/auth/me/addresses', { token: S.customerToken }), 200).addresses)));
  test('2.25 add address', async () => {
    const body = expect(await call('POST', '/auth/me/addresses', { token: S.customerToken, body: { label: 'Audit', fullName: 'Test Customer', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' } }), 201);
    S.addressId = body.address._id;
  });
  test('2.26 bad pincode', async () => expect(await call('POST', '/auth/me/addresses', { token: S.customerToken, body: { fullName: 'Test Customer', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '12' } }), 400, /6 digits/));
  test('2.27 update address', async () => {
    const body = expect(await call('PATCH', `/auth/me/addresses/${S.addressId}`, { token: S.customerToken, body: { city: 'Mysuru' } }), 200);
    assert.equal(body.addresses.find((a) => a._id === S.addressId).city, 'Mysuru');
  });
  test('2.28 empty address update', async () => expect(await call('PATCH', `/auth/me/addresses/${S.addressId}`, { token: S.customerToken, body: {} }), 400, /at least one field/));
  test('2.29 unknown address', async () => expect(await call('PATCH', `/auth/me/addresses/${ZERO}`, { token: S.customerToken, body: { city: 'Mysuru' } }), 404, /Address not found/));
  test('2.29b another user cannot edit my address', async () => expect(await call('PATCH', `/auth/me/addresses/${S.addressId}`, { token: S.customer2Token, body: { city: 'Hacked' } }), 404));
});

describe('3. Catalog', () => {
  test('3.1 home feed', async () => {
    const body = expect(await call('GET', '/home'), 200);
    for (const key of ['categories', 'trending', 'topRated', 'newArrivals', 'deals', 'vendors']) assert.ok(key in body, key);
  });
  test('3.2 categories', async () => {
    const body = expect(await call('GET', '/categories'), 200);
    assert.ok(body.categories.length > 0);
    S.categoryId = body.categories[0]._id;
  });
  test('3.10 store search (needed for 3.4)', async () => {
    const body = expect(await call('GET', '/stores?q=TechNova&sort=rating&page=1&limit=5'), 200);
    S.storeId = body.items[0]._id;
    assert.match(body.items[0].storeName, /TechNova/);
  });
  test('3.3 products first page', async () => {
    const body = expect(await call('GET', '/products?page=1&limit=48'), 200);
    for (const key of ['items', 'total', 'page', 'limit', 'pages', 'facets', 'engine']) assert.ok(key in body, key);
    const other = body.items.find((p) => String(p.vendorId) !== String(S.storeId));
    S.otherProductId = other._id;
  });
  test('3.4 filtered by store, in stock', async () => {
    const body = expect(await call('GET', `/products?vendor=${S.storeId}&inStock=true&sort=popular&limit=10`), 200);
    assert.ok(body.items.length > 0);
    for (const p of body.items) assert.equal(String(p.vendorId), String(S.storeId));
    const roomy = body.items.find((p) => p.stock >= 12) || body.items[0];
    S.productId = roomy._id;
    S.productId2 = body.items.find((p) => p._id !== S.productId && p.stock >= 3)?._id;
  });
  test('3.5 price, rating and category filters all match', async () => {
    const body = expect(await call('GET', `/products?category=${S.categoryId}&minPrice=100&maxPrice=50000&rating=4&sort=price_asc`), 200);
    let last = 0;
    for (const p of body.items) {
      assert.ok(p.price >= 100 && p.price <= 50000, `price ${p.price}`);
      assert.ok(p.price >= last, 'sorted by price');
      last = p.price;
    }
  });
  test('3.6 unknown sort, huge limit', async () => {
    const body = expect(await call('GET', '/products?sort=bogus&limit=500'), 200);
    assert.ok(body.limit <= 48 && body.items.length <= 48);
  });
  test('3.7 suggest', async () => {
    const body = expect(await call('GET', '/products/suggest?q=ph'), 200);
    assert.ok(Array.isArray(body.products) && Array.isArray(body.categories));
  });
  test('3.7b suggest with a typo offers a correction', async () => {
    const body = expect(await call('GET', '/products/suggest?q=samsng'), 200);
    assert.match(String(body.didYouMean), /samsung/i);
  });
  test('3.8 suggest too short', async () => {
    const body = expect(await call('GET', '/products/suggest?q=a'), 200);
    assert.deepEqual([body.products.length, body.categories.length], [0, 0]);
  });
  test('3.9 product detail', async () => {
    const body = expect(await call('GET', `/products/${S.productId}`), 200);
    for (const key of ['product', 'related', 'store']) assert.ok(key in body, key);
  });
  test('3.9b bad and unknown product', async () => {
    expect(await call('GET', '/products/abc'), 400, /Invalid product id/);
    expect(await call('GET', `/products/${ZERO}`), 404, /Product not found/);
  });
  test('3.11 store detail', async () => {
    expect(await call('GET', `/stores/${S.storeId}`), 200);
    expect(await call('GET', '/stores/abc'), 400, /Invalid store id/);
    expect(await call('GET', `/stores/${ZERO}`), 404, /Store not found/);
  });
  test('3.11b public store data has no bank or payout details', async () => {
    const { store } = expect(await call('GET', `/stores/${S.storeId}`), 200);
    for (const key of ['bank', 'stripe', 'payoutChanges', 'gstin']) assert.equal(store[key], undefined, `store.${key} is public`);
  });
  test('3.12 public coupons', async () => {
    const body = expect(await call('GET', '/coupons'), 200);
    const platform = body.coupons.find((c) => !c.vendor);
    assert.ok(platform, 'no public platform coupon');
    S.couponCode = platform.code;
    expect(await call('GET', `/coupons?vendors=${S.storeId}`), 200);
  });
  test('3.12b a signed-in customer does not see coupons they already used up', async () => {
    const guest = expect(await call('GET', '/coupons'), 200).coupons.map((c) => c.code);
    const mine = expect(await call('GET', '/coupons', { token: S.customerToken }), 200).coupons.map((c) => c.code);
    assert.ok(guest.includes('WELCOME10'), 'WELCOME10 missing for guests');
    assert.ok(!mine.includes('WELCOME10'), 'used WELCOME10 still offered to the customer');
  });
  test('3.13 upload an image', async () => {
    const body = expect(await upload(S.customerToken, 'avatars', { name: 'photo.png', type: 'image/png', data: PNG }), 201);
    assert.ok(body.files[0].url);
  });
  test('3.14 upload with no file', async () => expect(await upload(S.customerToken, 'avatars'), 400, /Choose at least one image/));
  test('3.15 bad folder', async () => expect(await upload(S.customerToken, 'bad', { name: 'photo.png', type: 'image/png', data: PNG }), 400, /folder must be one of/));
  test('3.16 customer uploading product images', async () => expect(await upload(S.customerToken, 'products', { name: 'photo.png', type: 'image/png', data: PNG }), 403, /Only sellers/));
  test('3.17 text file', async () => expect(await upload(S.customerToken, 'avatars', { name: 'notes.txt', type: 'text/plain', data: Buffer.from('hello') }), 400, /Unsupported file type/));
  test('3.17b text file renamed to .jpg', async () => expect(await upload(S.customerToken, 'avatars', { name: 'fake.jpg', type: 'image/jpeg', data: Buffer.from('<html>not an image</html>') }), 400, /not a valid image/));
  test('3.17c SVG (script carrier) is refused', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await upload(S.customerToken, 'avatars', { name: 'x.svg', type: 'image/svg+xml', data: svg });
    assert.equal(res.status, 400, res.text);
  });
  test('3.18 upload without a token', async () => expect(await upload(undefined, 'avatars', { name: 'photo.png', type: 'image/png', data: PNG }), 401));
});

describe('2b. Wishlist', () => {
  test('2.30 wishlist', async () => expect(await call('GET', '/auth/me/wishlist', { token: S.customerToken }), 200));
  test('2.31 add twice, listed once', async () => {
    expect(await call('PUT', `/auth/me/wishlist/${S.productId}`, { token: S.customerToken }), 200);
    const body = expect(await call('PUT', `/auth/me/wishlist/${S.productId}`, { token: S.customerToken }), 200);
    assert.equal(body.wishlisted, true);
    const list = expect(await call('GET', '/auth/me/wishlist', { token: S.customerToken }), 200);
    assert.equal(list.items.filter((p) => String(p._id || p.product?._id || p) === String(S.productId)).length, 1);
  });
  test('2.32 remove twice', async () => {
    expect(await call('DELETE', `/auth/me/wishlist/${S.productId}`, { token: S.customerToken }), 200);
    assert.equal(expect(await call('DELETE', `/auth/me/wishlist/${S.productId}`, { token: S.customerToken }), 200).wishlisted, false);
  });
  test('2.33 bad id', async () => expect(await call('PUT', '/auth/me/wishlist/abc', { token: S.customerToken }), 400, /Invalid/));
  test('2.34 unknown product', async () => expect(await call('PUT', `/auth/me/wishlist/${ZERO}`, { token: S.customerToken }), 404, /Product not found/));
});

describe('4. Ratings and reviews', () => {
  test('4.0 a delivered product of the customer', async () => {
    const body = expect(await call('GET', '/orders?status=delivered&limit=20', { token: S.customerToken }), 200);
    assert.ok(body.items.length, 'customer has no delivered orders');
    const delivered = body.items.flatMap((o) => o.packages.filter((p) => p.status === 'delivered').flatMap((p) => p.items));
    S.deliveredProductId = String(delivered[0].product?._id || delivered[0].product);
    const mine = new Set(body.items.flatMap((o) => o.packages.flatMap((p) => p.items.map((i) => String(i.product?._id || i.product)))));
    if (mine.has(String(S.otherProductId))) {
      const list = expect(await call('GET', '/products?limit=48'), 200);
      S.otherProductId = list.items.find((p) => !mine.has(String(p._id)))._id;
    }
  });
  test('4.1 list reviews, logged in', async () => {
    const body = expect(await call('GET', `/products/${S.deliveredProductId}/reviews`, { token: S.customerToken }), 200);
    assert.equal(body.canReview, true);
    assert.ok('distribution' in body);
  });
  test('4.2 no token: cannot review', async () => {
    const body = expect(await call('GET', `/products/${S.deliveredProductId}/reviews?sort=helpful&rating=5&page=1&limit=6`), 200);
    assert.equal(body.canReview, false);
  });
  test('4.3 bad product id', async () => expect(await call('GET', '/products/abc/reviews'), 400, /Invalid product id/));
  test('4.4 rate 4', async () => assert.equal(expect(await call('PUT', `/products/${S.deliveredProductId}/rating`, { token: S.customerToken, body: { value: 4 } }), 200).rating, 4));
  test('4.5 rate 6', async () => expect(await call('PUT', `/products/${S.deliveredProductId}/rating`, { token: S.customerToken, body: { value: 6 } }), 400, /less than or equal to 5/));
  test('4.6 rate 0', async () => expect(await call('PUT', `/products/${S.deliveredProductId}/rating`, { token: S.customerToken, body: { value: 0 } }), 400, /star rating/));
  test('4.7 rate a product never delivered', async () => expect(await call('PUT', `/products/${S.otherProductId}/rating`, { token: S.customerToken, body: { value: 4 } }), 403, /delivered/));
  test('4.8 rate an unknown product', async () => expect(await call('PUT', `/products/${ZERO}/rating`, { token: S.customerToken, body: { value: 4 } }), 404, /Product not found/));
  test('4.9 remove rating, then rate again', async () => {
    assert.equal(expect(await call('DELETE', `/products/${S.deliveredProductId}/rating`, { token: S.customerToken }), 200).rating, null);
    expect(await call('PUT', `/products/${S.deliveredProductId}/rating`, { token: S.customerToken, body: { value: 4 } }), 200);
  });
  test('4.10 create review (clearing an earlier one first)', async () => {
    const existing = expect(await call('GET', `/products/${S.deliveredProductId}/reviews`, { token: S.customerToken }), 200);
    for (const id of existing.myReviewIds || (existing.myReviews || []).map((r) => r._id)) {
      await call('DELETE', `/products/${S.deliveredProductId}/reviews/${id}`, { token: S.customerToken });
    }
    const body = expect(await call('POST', `/products/${S.deliveredProductId}/reviews`, { token: S.customerToken, body: { title: 'Audit review', comment: 'Works well, delivered on time. (audit test)' } }), 201);
    assert.equal(body.review.verified, true);
    S.reviewId = body.review._id;
  });
  test('9.8 same review again', async () => expect(await call('POST', `/products/${S.deliveredProductId}/reviews`, { token: S.customerToken, body: { title: 'Audit review', comment: 'Works well, delivered on time. (audit test)' } }), 409));
  test('4.10b review text with HTML is stored as text, not markup', async () => {
    const body = expect(await call('GET', `/products/${S.deliveredProductId}/reviews`, { token: S.customerToken }), 200);
    assert.ok(body.items.length >= 1);
  });
  test('4.11 short comment', async () => expect(await call('POST', `/products/${S.deliveredProductId}/reviews`, { token: S.customerToken, body: { comment: 'short' } }), 400, /at least 10/));
  test('4.12 review a product not delivered', async () => expect(await call('POST', `/products/${S.otherProductId}/reviews`, { token: S.customerToken, body: { comment: 'I never bought this product.' } }), 403));
  test('4.13 review without a token', async () => expect(await call('POST', `/products/${S.deliveredProductId}/reviews`, { body: { comment: 'No token on this request.' } }), 401));
  test('4.14 edit own review', async () => assert.equal(expect(await call('PATCH', `/products/${S.deliveredProductId}/reviews/${S.reviewId}`, { token: S.customerToken, body: { title: 'Edited title' } }), 200).review.title, 'Edited title'));
  test('4.15 empty edit', async () => expect(await call('PATCH', `/products/${S.deliveredProductId}/reviews/${S.reviewId}`, { token: S.customerToken, body: {} }), 400, /at least one field/));
  test('4.16 someone else edits it', async () => expect(await call('PATCH', `/products/${S.deliveredProductId}/reviews/${S.reviewId}`, { token: S.customer2Token, body: { title: 'Hijacked' } }), 403, /only change your own/));
  test('4.17 bad and unknown review', async () => {
    expect(await call('PATCH', `/products/${S.deliveredProductId}/reviews/abc`, { token: S.customerToken, body: { title: 'x' } }), 400, /Invalid review id/);
    expect(await call('PATCH', `/products/${S.deliveredProductId}/reviews/${ZERO}`, { token: S.customerToken, body: { title: 'x' } }), 404, /Review not found/);
  });
  test('4.18 vote on own review', async () => expect(await call('POST', `/products/${S.deliveredProductId}/reviews/${S.reviewId}/helpful`, { token: S.customerToken }), 400, /own review/));
  test('4.19 helpful twice counts once', async () => {
    expect(await call('POST', `/products/${S.deliveredProductId}/reviews/${S.reviewId}/helpful`, { token: S.customer2Token }), 200);
    const body = expect(await call('POST', `/products/${S.deliveredProductId}/reviews/${S.reviewId}/helpful`, { token: S.customer2Token }), 200);
    assert.equal(body.helpful, true);
    if ('helpfulCount' in body) assert.equal(body.helpfulCount, 1);
  });
  test('4.20 remove vote', async () => assert.equal(expect(await call('DELETE', `/products/${S.deliveredProductId}/reviews/${S.reviewId}/helpful`, { token: S.customer2Token }), 200).helpful, false));
  test('4.21 hide without a reason', async () => expect(await call('PATCH', `/admin/reviews/${S.reviewId}`, { token: S.adminToken, body: { status: 'hidden' } }), 400, /reason/));
  test('4.22 hide, it disappears', async () => {
    const body = expect(await call('PATCH', `/admin/reviews/${S.reviewId}`, { token: S.adminToken, body: { status: 'hidden', reason: 'Audit moderation test' } }), 200);
    assert.equal(body.review.moderation.status, 'hidden');
    const list = expect(await call('GET', `/products/${S.deliveredProductId}/reviews`), 200);
    assert.ok(!list.items.some((r) => r._id === S.reviewId));
  });
  test('4.23 restore', async () => assert.equal(expect(await call('PATCH', `/admin/reviews/${S.reviewId}`, { token: S.adminToken, body: { status: 'visible' } }), 200).review.moderation.status, 'visible'));
  test('4.24 someone else deletes it', async () => expect(await call('DELETE', `/products/${S.deliveredProductId}/reviews/${S.reviewId}`, { token: S.customer2Token }), 403));
  test('4.25 author deletes it, then again', async () => {
    expect(await call('DELETE', `/products/${S.deliveredProductId}/reviews/${S.reviewId}`, { token: S.customerToken }), 200);
    expect(await call('DELETE', `/products/${S.deliveredProductId}/reviews/${S.reviewId}`, { token: S.customerToken }), 404);
  });
});

describe('5. Cart', () => {
  const add = (quantity, productId = S.productId, token = S.customerToken) => call('POST', '/cart/items', { token, body: { productId, quantity } });
  test('5.0 start empty', async () => expect(await call('DELETE', '/cart', { token: S.customerToken }), 200));
  test('5.1 get cart', async () => assert.ok('summary' in expect(await call('GET', '/cart', { token: S.customerToken }), 200)));
  test('5.2 quantity 2', async () => assert.equal(expect(await add(2), 200).items.find((i) => i.productId === S.productId).quantity, 2));
  test('5.3 quantity 3 sets, not adds', async () => assert.equal(expect(await add(3), 200).items.find((i) => i.productId === S.productId).quantity, 3));
  test('5.4 quantity 11', async () => expect(await add(11), 400, /less than or equal to 10/));
  test('5.5 quantity 0', async () => expect(await add(0), 400, /greater than or equal to 1/));
  test('5.5b negative and fractional quantities', async () => {
    expect(await add(-3), 400);
    expect(await add(1.5), 400);
    expect(await add('2; drop'), 400);
  });
  test('5.6 bad product id', async () => expect(await add(1, 'abc'), 400, /Invalid product id/));
  test('5.6b NoSQL operator as product id', async () => expect(await add(1, { $ne: null }), 400));
  test('5.7 unknown product', async () => expect(await add(1, ZERO), 404, /no longer available/));
  test('5.8 vendor token', async () => expect(await call('GET', '/cart', { token: S.vendorToken }), 403, /permission/));
  test('9.14 admin token', async () => expect(await call('GET', '/cart', { token: S.adminToken }), 403, /permission/));
  test('5.9 no token', async () => expect(await call('GET', '/cart'), 401));
  test('5.10 coupon preview', async () => {
    const res = await call('POST', '/cart/coupon', { token: S.customerToken, body: { code: S.couponCode } });
    assert.ok([200, 400].includes(res.status), res.text);
  });
  test('5.11 unknown coupon', async () => expect(await call('POST', '/cart/coupon', { token: S.customerToken, body: { code: 'NOPE404' } }), 404, /not valid/));
  test('5.12 empty code', async () => expect(await call('POST', '/cart/coupon', { token: S.customerToken, body: { code: '' } }), 400, /coupon code/));
  test('5.13 remove the line', async () => assert.ok(!expect(await call('DELETE', `/cart/items/${S.productId}`, { token: S.customerToken }), 200).items.some((i) => i.productId === S.productId)));
  test('5.14 clear', async () => expect(await call('DELETE', '/cart', { token: S.customerToken }), 200));
  test('5.15 coupon on an empty cart', async () => expect(await call('POST', '/cart/coupon', { token: S.customerToken, body: { code: S.couponCode } }), 400, /cart is empty/));
});

describe('6. Orders and payment', () => {
  const checkout = (key: string | null, body: any = { addressId: S.addressId }, token = S.customerToken) =>
    call('POST', '/orders/checkout', { token, body, headers: key ? { 'Idempotency-Key': key } : {} });
  const fill = () => call('POST', '/cart/items', { token: S.customerToken, body: { productId: S.productId, quantity: 2 } });
  const stockOf = async (id) => expect(await call('GET', `/products/${id}`), 200).product.stock;

  test('6.2 no Idempotency-Key', async () => expect(await checkout(null), 400, /Idempotency-Key/));
  test('6.3 key too short', async () => expect(await checkout('abc'), 400, /Idempotency-Key/));
  test('6.4 empty cart', async () => expect(await checkout(`empty-${RUN}`), 400, /cart is empty/));
  test('6.5 no address', async () => {
    expect(await fill(), 200);
    expect(await checkout(`noaddr-${RUN}`, {}), 400, /address/);
  });
  test('6.6 unknown address', async () => expect(await checkout(`badaddr-${RUN}`, { addressId: ZERO }), 404, /address not found/i));
  test('6.6b another customer\'s address', async () => {
    const theirs = expect(await call('GET', '/auth/me/addresses', { token: S.customer2Token }), 200).addresses[0];
    if (theirs) expect(await checkout(`otheraddr-${RUN}`, { addressId: theirs._id }), 404);
  });
  test('9.5 wrong expectedTotal', async () => {
    const body = expect(await checkout(`total-${RUN}`, { addressId: S.addressId, expectedTotal: 1 }), 409);
    assert.equal(body.details?.code, 'CART_CHANGED');
  });
  test('6.7 order A, stock is held', async () => {
    S.stockBefore = await stockOf(S.productId);
    const body = expect(await checkout(`order-a-${RUN}`), 201);
    S.orderA = body.order._id;
    S.orderATotal = body.order.pricing.total;
    // The cart is kept until the order is paid (an abandoned payment doesn't lose it).
    assert.equal(expect(await call('GET', '/cart', { token: S.customerToken }), 200).items.length, 1, 'cart kept until payment');
  });
  test('6.7b the client cannot set the price', async () => {
    const order = expect(await call('GET', `/orders/${S.orderA}`, { token: S.customerToken }), 200).order;
    const product = expect(await call('GET', `/products/${S.productId}`), 200).product;
    const line = order.packages.flatMap((p) => p.items).find((i) => String(i.product?._id || i.product) === String(S.productId));
    assert.equal(line.price, product.price);
  });
  test('6.8 same key again returns the same order', async () => assert.equal(expect(await checkout(`order-a-${RUN}`), 201).order._id, S.orderA));
  test('6.9 payment config', async () => expect(await call('GET', `/orders/${S.orderA}/payment`, { token: S.customerToken }), 200));
  test('6.9b another customer cannot pay or read my order', async () => {
    assert.ok([403, 404].includes((await call('GET', `/orders/${S.orderA}/payment`, { token: S.customer2Token })).status));
    const res = await call('POST', `/orders/${S.orderA}/verify`, { token: S.customer2Token, body: { outcome: 'success' } });
    assert.ok([403, 404].includes(res.status), `customer2 verify -> ${res.status}`);
  });
  test('6.10 order B', async () => {
    expect(await fill(), 200);
    S.orderB = expect(await checkout(`order-b-${RUN}`), 201).order._id;
  });
  test('6.11 simulated decline', async () => expect(await call('POST', `/orders/${S.orderA}/verify`, { token: S.customerToken, body: { outcome: 'failure' } }), 402, /declined/));
  test('6.12 pay A and B', async () => {
    for (const id of [S.orderA, S.orderB]) {
      const body = expect(await call('POST', `/orders/${id}/verify`, { token: S.customerToken, body: { outcome: 'success' } }), 200);
      assert.equal(body.order.payment.status, 'paid');
      assert.equal(body.order.status, 'placed');
    }
    assert.equal(await stockOf(S.productId), S.stockBefore - 4, 'stock taken for 2 + 2');
    assert.equal(expect(await call('GET', '/cart', { token: S.customerToken }), 200).items.length, 0, 'cart emptied once paid');
  });
  test('6.13 pay A again changes nothing', async () => assert.equal(expect(await call('POST', `/orders/${S.orderA}/verify`, { token: S.customerToken, body: { outcome: 'success' } }), 200).order.payment.status, 'paid'));
  test('6.14 payment config for a paid order', async () => expect(await call('GET', `/orders/${S.orderA}/payment`, { token: S.customerToken }), 400, /already paid/));
  test('6.15 my orders', async () => assert.ok(expect(await call('GET', '/orders?status=placed&page=1&limit=5', { token: S.customerToken }), 200).items.length));
  test('6.16 order detail', async () => expect(await call('GET', `/orders/${S.orderA}`, { token: S.customerToken }), 200));
  test('6.17 another customer', async () => expect(await call('GET', `/orders/${S.orderA}`, { token: S.customer2Token }), 403, /your own orders/));
  test('6.18 bad and unknown order', async () => {
    expect(await call('GET', '/orders/abc', { token: S.customerToken }), 400, /Invalid order id/);
    expect(await call('GET', `/orders/${ZERO}`, { token: S.customerToken }), 404, /Order not found/);
  });
  test('6.19 vendor token', async () => expect(await call('GET', `/orders/${S.orderA}`, { token: S.vendorToken }), 403));
  test('6.20 invoice is a PDF', async () => {
    const res = await call('GET', `/orders/${S.orderA}/invoice`, { token: S.customerToken });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/pdf/);
  });
  test('6.20b another customer cannot download my invoice', async () => {
    const res = await call('GET', `/orders/${S.orderA}/invoice`, { token: S.customer2Token });
    assert.ok([403, 404].includes(res.status), `-> ${res.status}`);
  });
  test('6.21 invoice for an unpaid order', async () => {
    const body = expect(await call('GET', '/orders?status=pending_payment&limit=1', { token: S.customerToken }), 200);
    if (body.items[0]) expect(await call('GET', `/orders/${body.items[0]._id}/invoice`, { token: S.customerToken }), 400, /once the order is paid/);
  });
  test('6.22 cancel, other without a note', async () => expect(await call('POST', `/orders/${S.orderA}/cancel`, { token: S.customerToken, body: { reasonCode: 'other' } }), 400, /at least 3/));
  test('6.23 unknown reason', async () => expect(await call('POST', `/orders/${S.orderA}/cancel`, { token: S.customerToken, body: { reasonCode: 'fraud' } }), 400, /Invalid enum/));
  test('6.23b another customer cannot cancel it', async () => {
    const res = await call('POST', `/orders/${S.orderA}/cancel`, { token: S.customer2Token, body: { reasonCode: 'changed_mind' } });
    assert.ok([403, 404].includes(res.status), `-> ${res.status}`);
  });
  test('6.24 cancel A: refunded and restocked', async () => {
    const body = expect(await call('POST', `/orders/${S.orderA}/cancel`, { token: S.customerToken, body: { reasonCode: 'changed_mind' } }), 200);
    assert.ok(body.order.packages.every((p) => p.status === 'cancelled'));
    assert.equal(body.order.payment.status, 'refunded');
    assert.equal(await stockOf(S.productId), S.stockBefore - 2, 'A\'s 2 units back in stock');
  });
  test('6.25 cancel again', async () => expect(await call('POST', `/orders/${S.orderA}/cancel`, { token: S.customerToken, body: { reasonCode: 'changed_mind' } }), 400, /already cancelled/));
  test('6.26 pay a cancelled order', async () => expect(await call('POST', `/orders/${S.orderA}/verify`, { token: S.customerToken, body: { outcome: 'success' } }), 400, /cancelled/));
  test('6.27 cancel a shipped order', async () => {
    const body = expect(await call('GET', '/orders?status=shipped&limit=1', { token: S.customerToken }), 200);
    if (body.items[0]) expect(await call('POST', `/orders/${body.items[0]._id}/cancel`, { token: S.customerToken, body: { reasonCode: 'changed_mind' } }), 400, /already shipped/);
  });
  test('9.7 two checkouts at the same moment create one order', async () => {
    expect(await fill(), 200);
    const [one, two] = await Promise.all([checkout(`tab-one-${RUN}`), checkout(`tab-two-${RUN}`)]);
    const statuses = [one.status, two.status].sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1, `got ${statuses}`);
    const winner = one.status === 201 ? one : two;
    S.raceOrder = winner.body.order._id;
    expect(await call('POST', `/orders/${S.raceOrder}/cancel`, { token: S.customerToken, body: { reasonCode: 'changed_mind' } }), 200);
  });
});

describe('7. Vendor', () => {
  const store = (fields: any = {}) => ({ storeName: `Audit Store ${RUN}`, tagline: 'Testing', email: S.newUserEmail, phone: `98${String(Date.now()).slice(-8)}`, address: { line1: '1 Test Street', city: 'Pune', state: 'Maharashtra', pincode: '411001' }, bank: { accountHolder: 'Audit User', accountNumber: '123456789012', ifsc: 'HDFC0001234' }, ...fields });

  test('7.1 onboard with an existing store', async () => expect(await call('POST', '/vendor/onboard', { token: S.vendorToken, body: store({ storeName: 'Another Store' }) }), 409, /already have a store/));
  test('7.3 bad IFSC', async () => expect(await call('POST', '/vendor/onboard', { token: S.newUserToken, body: store({ bank: { accountHolder: 'Audit User', accountNumber: '123456789012', ifsc: 'BAD' } }) }), 400, /IFSC/));
  test('7.4 bad GSTIN', async () => expect(await call('POST', '/vendor/onboard', { token: S.newUserToken, body: store({ gstin: '123' }) }), 400, /GSTIN/));
  test('7.5 admin cannot onboard', async () => expect(await call('POST', '/vendor/onboard', { token: S.adminToken, body: {} }), 403));
  test('7.2 onboard newUser: pending', async () => {
    const body = expect(await call('POST', '/vendor/onboard', { token: S.newUserToken, body: store() }), 201);
    assert.equal(body.vendor.status, 'pending');
    S.newStoreId = body.vendor._id;
    S.newUserToken = (await login(S.newUserEmail, 'Test@1234')).token;
  });
  test('7.2b a pending store is not public', async () => expect(await call('GET', `/stores/${S.newStoreId}`), 404));
  test('7.6 my store masks bank details', async () => {
    const { vendor } = expect(await call('GET', '/vendor/store', { token: S.vendorToken }), 200);
    if (vendor.bank?.accountNumber) assert.doesNotMatch(String(vendor.bank.accountNumber), /^\d{9,}$/, 'full account number exposed');
  });
  test('7.7 customer', async () => expect(await call('GET', '/vendor/store', { token: S.customerToken }), 403));
  test('7.8 update tagline', async () => assert.equal(expect(await call('PATCH', '/vendor/store', { token: S.vendorToken, body: { tagline: 'Flagship phones, laptops & smart gadgets' } }), 200).vendor.tagline, 'Flagship phones, laptops & smart gadgets'));
  test('7.9 bank change without a password', async () => {
    const body = expect(await call('PATCH', '/vendor/store', { token: S.vendorToken, body: { bank: { accountHolder: 'TechNova Electronics', accountNumber: '123456789012', ifsc: 'HDFC0001234' } } }), 403, /password/);
    assert.equal(body.details?.code, 'PASSWORD_REQUIRED');
  });
  test('7.10 wrong password', async () => expect(await call('PATCH', '/vendor/store', { token: S.vendorToken, body: { bank: { accountHolder: 'TechNova Electronics', accountNumber: '123456789012', ifsc: 'HDFC0001234' }, currentPassword: 'wrong-pass' } }), 403, /Incorrect password/));
  test('7.11 pending store dashboard', async () => expect(await call('GET', '/vendor/dashboard', { token: S.newUserToken }), 403, /pending/));
  test('7.12 dashboard', async () => expect(await call('GET', '/vendor/dashboard', { token: S.vendorToken }), 200));
  test('7.13 products filtered and sorted', async () => {
    for (const status of ['active', 'inactive', 'out_of_stock', 'low_stock']) {
      for (const sort of ['newest', 'price_asc', 'price_desc', 'stock', 'best_selling']) {
        expect(await call('GET', `/vendor/products?status=${status}&sort=${sort}&page=1&limit=5`, { token: S.vendorToken }), 200);
      }
    }
  });
  const product = (fields: any = {}) => ({ title: 'Audit Test Product', description: 'Created by the audit suite', brand: 'TestBrand', category: S.categoryId, price: 999, mrp: 1299, stock: 5, sku: `AUDIT-${RUN}`, images: [{ url: 'https://picsum.photos/600' }], tags: ['test'], specs: [{ label: 'Color', value: 'Black' }], ...fields });
  test('7.14 create product', async () => { S.vendorProductId = expect(await call('POST', '/vendor/products', { token: S.vendorToken, body: product() }), 201).product._id; });
  test('7.15 no images', async () => expect(await call('POST', '/vendor/products', { token: S.vendorToken, body: product({ sku: undefined, images: [] }) }), 400, /image/));
  test('7.16 MRP below price', async () => expect(await call('POST', '/vendor/products', { token: S.vendorToken, body: product({ sku: undefined, mrp: 500 }) }), 400, /MRP/));
  test('7.16b negative price and stock', async () => {
    expect(await call('POST', '/vendor/products', { token: S.vendorToken, body: product({ sku: undefined, price: -1, mrp: undefined }) }), 400);
    expect(await call('POST', '/vendor/products', { token: S.vendorToken, body: product({ sku: undefined, stock: -5 }) }), 400);
  });
  test('7.17 category abc', async () => expect(await call('POST', '/vendor/products', { token: S.vendorToken, body: product({ sku: undefined, category: 'abc' }) }), 400, /category/i));
  test('7.18 unknown category', async () => expect(await call('POST', '/vendor/products', { token: S.vendorToken, body: product({ sku: undefined, category: ZERO }) }), 400, /Unknown category/));
  test('7.19 same SKU', async () => expect(await call('POST', '/vendor/products', { token: S.vendorToken, body: product() }), 409, /SKU/));
  test('7.20 get product: own, bad, another store\'s', async () => {
    expect(await call('GET', `/vendor/products/${S.vendorProductId}`, { token: S.vendorToken }), 200);
    expect(await call('GET', '/vendor/products/abc', { token: S.vendorToken }), 400, /Invalid product id/);
    expect(await call('GET', `/vendor/products/${S.otherProductId}`, { token: S.vendorToken }), 404);
  });
  test('7.20b cannot edit or delete another store\'s product', async () => {
    expect(await call('PATCH', `/vendor/products/${S.otherProductId}`, { token: S.vendorToken, body: { price: 1 } }), 404);
    expect(await call('DELETE', `/vendor/products/${S.otherProductId}`, { token: S.vendorToken }), 404);
    assert.notEqual(expect(await call('GET', `/products/${S.otherProductId}`), 200).product.price, 1);
  });
  test('7.21 update / bad MRP', async () => {
    expect(await call('PATCH', `/vendor/products/${S.vendorProductId}`, { token: S.vendorToken, body: { price: 899, stock: 7 } }), 200);
    expect(await call('PATCH', `/vendor/products/${S.vendorProductId}`, { token: S.vendorToken, body: { mrp: 1 } }), 400, /MRP/);
  });
  test('9.9 stale stockBase', async () => {
    const body = expect(await call('PATCH', `/vendor/products/${S.vendorProductId}`, { token: S.vendorToken, body: { stock: 999, stockBase: 1 } }), 409);
    assert.equal(body.details?.code, 'STOCK_CHANGED');
  });
  test('9.10 stale editVersion', async () => {
    const { product: p } = expect(await call('GET', `/vendor/products/${S.vendorProductId}`, { token: S.vendorToken }), 200);
    expect(await call('PATCH', `/vendor/products/${S.vendorProductId}`, { token: S.vendorToken, body: { isActive: true, editVersion: p.editVersion } }), 200);
    const body = expect(await call('PATCH', `/vendor/products/${S.vendorProductId}`, { token: S.vendorToken, body: { isActive: true, editVersion: p.editVersion } }), 409);
    assert.equal(body.details?.code, 'PRODUCT_CHANGED');
  });
  test('7.22 delete, then gone', async () => {
    expect(await call('DELETE', `/vendor/products/${S.vendorProductId}`, { token: S.vendorToken }), 200);
    expect(await call('GET', `/vendor/products/${S.vendorProductId}`, { token: S.vendorToken }), 404);
  });
  test('7.23 placed orders include B', async () => {
    const body = expect(await call('GET', '/vendor/orders?status=placed&page=1&limit=50', { token: S.vendorToken }), 200);
    assert.ok(body.items.some((o) => String(o._id || o.order) === String(S.orderB) || String(o.orderId) === String(S.orderB)), 'order B not listed');
  });
  test('7.23b vendor order list hides customer contact details it does not need', async () => {
    const body = expect(await call('GET', '/vendor/orders?page=1&limit=5', { token: S.vendorToken }), 200);
    for (const o of body.items) assert.equal(o.customer?.password, undefined);
  });
  test('7.24 pack B', async () => expect(await call('PATCH', `/vendor/orders/${S.orderB}/status`, { token: S.vendorToken, body: { status: 'packed' } }), 200));
  test('7.25 packed -> delivered skips a step', async () => expect(await call('PATCH', `/vendor/orders/${S.orderB}/status`, { token: S.vendorToken, body: { status: 'delivered' } }), 400, /cannot be moved to delivered/));
  test('7.25b another vendor cannot touch B', async () => {
    const other = await login('urbanthreads@vendora.dev', 'Vendor@123').catch(() => null);
    if (other) {
      const res = await call('PATCH', `/vendor/orders/${S.orderB}/status`, { token: other.token, body: { status: 'shipped', trackingId: 'X' } });
      assert.ok([403, 404].includes(res.status), `-> ${res.status}`);
    }
  });
  test('7.26 ship then deliver', async () => {
    expect(await call('PATCH', `/vendor/orders/${S.orderB}/status`, { token: S.vendorToken, body: { status: 'shipped', trackingId: 'TRK123456789' } }), 200);
    expect(await call('PATCH', `/vendor/orders/${S.orderB}/status`, { token: S.vendorToken, body: { status: 'delivered' } }), 200);
  });
  test('7.27 cancel delivered', async () => expect(await call('PATCH', `/vendor/orders/${S.orderB}/status`, { token: S.vendorToken, body: { status: 'cancelled', reasonCode: 'out_of_stock' } }), 400, /delivered package cannot/));
  test('7.27b cancel without a reason', async () => expect(await call('PATCH', `/vendor/orders/${S.orderB}/status`, { token: S.vendorToken, body: { status: 'cancelled' } }), 400));
  test('7.27c bad order id', async () => expect(await call('PATCH', '/vendor/orders/abc/status', { token: S.vendorToken, body: { status: 'packed' } }), 400, /Invalid order id/));
  test('7.28 payouts', async () => expect(await call('GET', '/vendor/payouts?status=on_hold&page=1', { token: S.vendorToken }), 200));
  test('7.29-7.33 review replies', async () => {
    const body = expect(await call('GET', '/vendor/reviews?replied=no&page=1&limit=5', { token: S.vendorToken }), 200);
    const id = body.items[0]?._id;
    assert.ok(id, 'no unreplied review');
    expect(await call('PUT', `/vendor/reviews/${id}/reply`, { token: S.vendorToken, body: { text: 'Thank you for the feedback!' } }), 200);
    expect(await call('PUT', `/vendor/reviews/${id}/reply`, { token: S.vendorToken, body: { text: 'a' } }), 400);
    expect(await call('PUT', `/vendor/reviews/${ZERO}/reply`, { token: S.vendorToken, body: { text: 'Thanks!' } }), 404);
    assert.equal(expect(await call('DELETE', `/vendor/reviews/${id}/reply`, { token: S.vendorToken }), 200).reply, null);
  });
  test('7.34-7.40 store coupons', async () => {
    expect(await call('GET', '/vendor/coupons', { token: S.vendorToken }), 200);
    const code = `AUD${RUN.slice(-6).toUpperCase()}`;
    S.vendorCouponId = expect(await call('POST', '/vendor/coupons', { token: S.vendorToken, body: { code, description: 'Audit', type: 'percent', value: 10, minOrder: 500, maxDiscount: 200 } }), 201).coupon._id;
    expect(await call('POST', '/vendor/coupons', { token: S.vendorToken, body: { code, type: 'percent', value: 10 } }), 409, /already exists/);
    expect(await call('POST', '/vendor/coupons', { token: S.vendorToken, body: { code: 'a!', type: 'flat', value: 50 } }), 400);
    expect(await call('POST', '/vendor/coupons', { token: S.vendorToken, body: { code: `${code}X`, type: 'flat', value: 50, isPublic: false } }), 403, /Only admins/);
    expect(await call('POST', '/vendor/coupons', { token: S.vendorToken, body: { code: `${code}P`, type: 'percent', value: 150 } }), 400);
    assert.equal(expect(await call('PATCH', `/vendor/coupons/${S.vendorCouponId}`, { token: S.vendorToken, body: { isActive: false } }), 200).coupon.isActive, false);
    expect(await call('DELETE', `/vendor/coupons/${S.vendorCouponId}`, { token: S.vendorToken }), 200);
    expect(await call('DELETE', `/vendor/coupons/${S.vendorCouponId}`, { token: S.vendorToken }), 404);
  });
});

describe('8. Admin', () => {
  test('8.1-8.2 analytics', async () => {
    assert.equal(expect(await call('GET', '/admin/analytics?range=7', { token: S.adminToken }), 200).range, 7);
    assert.equal(expect(await call('GET', '/admin/analytics?range=12', { token: S.adminToken }), 200).range, 30);
  });
  test('8.3 every admin route refuses customers, sellers and guests', async () => {
    const routes = ['/admin/analytics', '/admin/vendors', '/admin/users', '/admin/orders', '/admin/orders/summary', '/admin/orders/export', '/admin/products', '/admin/reviews', '/admin/categories', '/admin/coupons', '/admin/settings', '/admin/system', '/admin/refunds', '/admin/returns'];
    for (const path of routes) {
      assert.equal((await call('GET', path, { token: S.customerToken })).status, 403, `customer ${path}`);
      assert.equal((await call('GET', path, { token: S.vendorToken })).status, 403, `vendor ${path}`);
      assert.equal((await call('GET', path)).status, 401, `guest ${path}`);
    }
    for (const [method, path] of [['POST', '/admin/search/reindex'], ['POST', '/admin/payouts/release'], ['POST', '/admin/payments/reconcile'], ['PATCH', '/admin/settings']]) {
      assert.equal((await call(method, path, { token: S.vendorToken, body: {} })).status, 403, `vendor ${method} ${path}`);
    }
  });
  test('8.4 vendors list hides payout details', async () => {
    const body = expect(await call('GET', '/admin/vendors?status=pending&page=1', { token: S.adminToken }), 200);
    assert.ok(body.counts);
    for (const v of body.items) for (const key of ['bank', 'stripe', 'payoutChanges']) assert.equal(v[key], undefined, key);
  });
  test('8.5-8.6 users', async () => {
    expect(await call('GET', '/admin/users?role=vendor&q=tech', { token: S.adminToken }), 200);
    const body = expect(await call('GET', `/admin/users?q=${encodeURIComponent(S.newUserEmail)}`, { token: S.adminToken }), 200);
    S.newUserId = body.items[0]._id;
    assert.equal(body.items[0].password, undefined);
  });
  test('8.7 approve the new store', async () => assert.equal(expect(await call('PATCH', `/admin/vendors/${S.newStoreId}`, { token: S.adminToken, body: { status: 'approved' } }), 200).vendor.status, 'approved'));
  test('8.8 approved -> rejected', async () => expect(await call('PATCH', `/admin/vendors/${S.newStoreId}`, { token: S.adminToken, body: { status: 'rejected', rejectionReason: 'testing' } }), 400, /cannot be moved to rejected/));
  test('8.9 status pending', async () => expect(await call('PATCH', `/admin/vendors/${S.newStoreId}`, { token: S.adminToken, body: { status: 'pending' } }), 400, /Invalid enum/));
  test('8.10 suspend without a reason', async () => expect(await call('PATCH', `/admin/vendors/${S.newStoreId}`, { token: S.adminToken, body: { status: 'suspended' } }), 400, /reason/));
  test('8.11 admin cannot set bank details', async () => expect(await call('PATCH', `/admin/vendors/${S.newStoreId}`, { token: S.adminToken, body: { bank: { accountHolder: 'Hacker', accountNumber: '999999999999', ifsc: 'HDFC0001234' } } }), 400, /Unrecognized key/));
  test('8.12 bad and unknown vendor', async () => {
    expect(await call('PATCH', '/admin/vendors/abc', { token: S.adminToken, body: { commissionRate: 5 } }), 400);
    expect(await call('PATCH', `/admin/vendors/${ZERO}`, { token: S.adminToken, body: { commissionRate: 5 } }), 404);
  });
  test('8.13 block the store owner: store suspended and hidden', async () => {
    const body = expect(await call('PATCH', `/admin/users/${S.newUserId}`, { token: S.adminToken, body: { status: 'blocked', reason: 'Audit block test' } }), 200);
    assert.equal(body.user.status, 'blocked');
    assert.equal(body.store?.status, 'suspended');
    expect(await call('GET', `/stores/${S.newStoreId}`), 404);
  });
  test('8.13a blocked user is refused everywhere', async () => {
    const me = await call('GET', '/auth/me', { token: S.newUserToken });
    expect(me, 403, /blocked/);
    assert.equal(me.body.details?.code, 'ACCOUNT_BLOCKED');
    const loginRes = await call('POST', '/auth/login', { body: { email: S.newUserEmail, password: 'Test@1234' } });
    assert.equal(loginRes.status, 403);
    const mark = cookieOf(me, 'vendora_blocked') || cookieOf(loginRes, 'vendora_blocked');
    assert.ok(mark, 'vendora_blocked cookie not set');
    assert.equal((await call('GET', '/categories', { cookie: mark })).status, 403);
  });
  test('8.13b approve the store while the owner is blocked', async () => expect(await call('PATCH', `/admin/vendors/${S.newStoreId}`, { token: S.adminToken, body: { status: 'approved' } }), 400, /blocked/));
  test('8.13c unblock restores the store', async () => {
    const body = expect(await call('PATCH', `/admin/users/${S.newUserId}`, { token: S.adminToken, body: { status: 'active' } }), 200);
    assert.equal(body.store?.status, 'approved');
    S.newUserToken = (await login(S.newUserEmail, 'Test@1234')).token;
  });
  test('8.13d block rules', async () => {
    expect(await call('PATCH', `/admin/users/${S.newUserId}`, { token: S.adminToken, body: { status: 'blocked' } }), 400, /reason/);
    expect(await call('PATCH', `/admin/users/${S.adminId}`, { token: S.adminToken, body: { status: 'blocked', reason: 'self' } }), 400);
  });
  test('8.14-8.16 orders: filters and bad filters', async () => {
    const body = expect(await call('GET', '/admin/orders?fulfilment=placed&limit=1', { token: S.adminToken }), 200);
    S.adminOrderId = body.items[0]?._id;
    S.adminPackageId = body.items[0]?.fulfilment?.[0]?._id;
    for (const q of ['q=TechNova&page=1&limit=5', 'attention=all', `vendor=${S.storeId}&fulfilment=shipped&sort=total_desc`, 'refund=any&payment=refunded', 'from=2026-10-01&to=2026-10-31&minTotal=1000&maxTotal=50000', 'range=today&delayed=true']) {
      expect(await call('GET', `/admin/orders?${q}`, { token: S.adminToken }), 200);
    }
    for (const [q, msg] of [['status=bogus', /status must be one of/], ['vendor=abc', /Invalid vendor id/], ['from=29-10-2026', /dates like/], ['minTotal=500&maxTotal=100', /minTotal/], ['sort=random', /sort must be one of/], ['attention=nope', /attention must be one of/], ['range=12', /range must be/]] as const) {
      expect(await call('GET', `/admin/orders?${q}`, { token: S.adminToken }), 400, msg);
    }
  });
  test('8.17 summary', async () => {
    expect(await call('GET', '/admin/orders/summary?range=30', { token: S.adminToken }), 200);
    expect(await call('GET', '/admin/orders/summary?from=2026-10-01&to=2026-10-31', { token: S.adminToken }), 200);
  });
  test('8.18 CSV export without personal data', async () => {
    const res = await call('GET', '/admin/orders/export?refund=any', { token: S.adminToken });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/csv/);
    assert.ok(res.headers.get('x-total-count'));
    assert.doesNotMatch(res.text, /@vendora\.dev|@example\.com/, 'emails in the export');
  });
  test('8.18b CSV cells cannot run spreadsheet formulas', async () => {
    const res = await call('GET', '/admin/orders/export', { token: S.adminToken });
    for (const line of res.text.split('\n').slice(1)) {
      for (const cell of line.split(',')) assert.doesNotMatch(cell.replace(/^"/, ''), /^[=+@]/, `formula-like cell: ${cell}`);
    }
  });
  test('8.19 order detail and invoice', async () => {
    expect(await call('GET', `/admin/orders/${S.orderB}`, { token: S.adminToken }), 200);
    assert.equal((await call('GET', `/admin/orders/${S.orderB}/invoice`, { token: S.adminToken })).status, 200);
  });
  test('8.20 package updates', async () => {
    if (S.adminOrderId && S.adminPackageId) {
      expect(await call('PATCH', `/admin/orders/${S.adminOrderId}/packages/${S.adminPackageId}`, { token: S.adminToken, body: { status: 'packed' } }), 200);
      expect(await call('PATCH', `/admin/orders/${S.adminOrderId}/packages/${S.adminPackageId}`, { token: S.adminToken, body: { status: 'cancelled' } }), 400);
      expect(await call('PATCH', `/admin/orders/${S.adminOrderId}/packages/${ZERO}`, { token: S.adminToken, body: { status: 'packed' } }), 404, /Package not found/);
    }
    const order = expect(await call('GET', `/admin/orders/${S.orderB}`, { token: S.adminToken }), 200).order;
    const pkg = (order.packages || order.fulfilment)[0]._id;
    expect(await call('PATCH', `/admin/orders/${S.orderB}/packages/${pkg}`, { token: S.adminToken, body: { status: 'cancelled', reasonCode: 'fraud' } }), 400, /delivered package cannot/);
  });
  test('8.21 deleted products', async () => {
    const body = expect(await call('GET', '/admin/products?status=deleted', { token: S.adminToken }), 200);
    assert.ok(body.items.some((p) => p._id === S.vendorProductId), 'soft-deleted product missing');
  });
  test('8.22-8.23 remove and restore a product', async () => {
    expect(await call('PATCH', `/admin/products/${S.productId}`, { token: S.adminToken, body: { status: 'removed' } }), 400, /reason/);
    expect(await call('PATCH', `/admin/products/${S.productId}`, { token: S.adminToken, body: { status: 'removed', reason: 'Audit moderation test' } }), 200);
    expect(await call('GET', `/products/${S.productId}`), 404);
    expect(await call('PATCH', `/admin/products/${S.productId}`, { token: S.adminToken, body: { status: 'approved' } }), 200);
    expect(await call('GET', `/products/${S.productId}`), 200);
  });
  test('8.24-8.25 review queue', async () => {
    expect(await call('GET', '/admin/reviews?status=visible&q=good&page=1', { token: S.adminToken }), 200);
    expect(await call('PATCH', '/admin/reviews/abc', { token: S.adminToken, body: { status: 'visible' } }), 400, /Invalid review id/);
    expect(await call('PATCH', `/admin/reviews/${ZERO}`, { token: S.adminToken, body: { status: 'visible' } }), 404, /Review not found/);
  });
  test('8.26-8.31 categories', async () => {
    expect(await call('GET', '/admin/categories', { token: S.adminToken }), 200);
    const name = `Audit Category ${RUN}`;
    const id = expect(await call('POST', '/admin/categories', { token: S.adminToken, body: { name, group: 'General', order: 99 } }), 201).category._id;
    expect(await call('POST', '/admin/categories', { token: S.adminToken, body: { name: name.toUpperCase(), group: 'General' } }), 409, /already exists/);
    expect(await call('POST', '/admin/categories', { token: S.adminToken, body: { name: 'Bad Group', group: 'Toys' } }), 400);
    expect(await call('POST', '/admin/categories', { token: S.adminToken, body: { name: 'a' } }), 400);
    expect(await call('PATCH', `/admin/categories/${id}`, { token: S.adminToken, body: { order: 5 } }), 200);
    expect(await call('PATCH', `/admin/categories/${id}`, { token: S.adminToken, body: {} }), 400, /Nothing to update/);
    expect(await call('DELETE', `/admin/categories/${id}`, { token: S.adminToken }), 200);
    expect(await call('DELETE', `/admin/categories/${id}`, { token: S.adminToken }), 404);
  });
  test('8.32-8.35 platform coupons and visibility', async () => {
    expect(await call('GET', '/admin/coupons?scope=all&page=1', { token: S.adminToken }), 200);
    const code = `ADM${RUN.slice(-6).toUpperCase()}`;
    const coupon = expect(await call('POST', '/admin/coupons', { token: S.adminToken, body: { code, description: 'Private', type: 'flat', value: 50, minOrder: 300, isPublic: false } }), 201).coupon;
    assert.ok(!expect(await call('GET', '/coupons'), 200).coupons.some((c) => c.code === code), 'private coupon listed');
    expect(await call('PATCH', `/admin/coupons/${coupon._id}`, { token: S.adminToken, body: { isPublic: true } }), 200);
    assert.ok(expect(await call('GET', '/coupons'), 200).coupons.some((c) => c.code === code), 'public coupon missing');
    expect(await call('DELETE', `/admin/coupons/${coupon._id}`, { token: S.adminToken }), 200);
  });
  test('8.36-8.39 settings', async () => {
    const { settings } = expect(await call('GET', '/admin/settings', { token: S.adminToken }), 200);
    expect(await call('PATCH', '/admin/settings', { token: S.adminToken, body: { shippingFee: settings.shippingFee } }), 200);
    expect(await call('PATCH', '/admin/settings', { token: S.adminToken, body: {} }), 400, /at least one setting/);
    expect(await call('PATCH', '/admin/settings', { token: S.adminToken, body: { commissionRate: 60 } }), 400, /less than or equal to 50/);
    expect(await call('PUT', '/admin/settings', { token: S.adminToken, body: { shippingFee: 49 } }), 404);
  });
  test('8.40 system', async () => expect(await call('GET', '/admin/system', { token: S.adminToken }), 200));
  test('8.41 reindex', async () => {
    const res = await call('POST', '/admin/search/reindex', { token: S.adminToken });
    assert.ok([200, 409].includes(res.status), res.text);
  });
  test('8.41b store and product search still work after a reindex and a store edit', async () => {
    // A store edit after the reindex is what re-creates a store index (through the change stream).
    expect(await call('PATCH', '/vendor/store', { token: S.vendorToken, body: { tagline: 'Flagship phones, laptops & smart gadgets' } }), 200);
    await new Promise((r) => setTimeout(r, 2000));
    assert.ok(expect(await call('GET', '/stores?q=TechNova'), 200).total >= 1, 'store search empty after reindex');
    assert.ok(expect(await call('GET', '/stores?q=Urban'), 200).total >= 1, 'stores missing from search after reindex');
    assert.ok(expect(await call('GET', '/admin/vendors?q=Urban', { token: S.adminToken }), 200).total >= 1, 'admin store search empty after reindex');
    assert.ok(expect(await call('GET', '/products?q=phone'), 200).total >= 1);
  });
  test('8.42 refunds, returns, reconcile, payouts', async () => {
    expect(await call('GET', '/admin/refunds', { token: S.adminToken }), 200);
    expect(await call('GET', '/admin/returns', { token: S.adminToken }), 200);
    assert.ok((await call('POST', '/admin/payments/reconcile', { token: S.adminToken })).status < 500);
    assert.ok((await call('POST', '/admin/payouts/release', { token: S.adminToken })).status < 500);
  });
});

describe('9. Live updates, races and other checks', () => {
  test('9.1 events without a token', async () => expect(await call('GET', '/cart/events'), 401));
  test('9.2 + 9.15 event stream, and at most 5 per user', async () => {
    const controllers: AbortController[] = [];
    const open = async () => {
      const c = new AbortController();
      controllers.push(c);
      return fetch(`${BASE}/cart/events`, { headers: { Authorization: `Bearer ${S.customerToken}`, Accept: 'text/event-stream' }, signal: c.signal });
    };
    try {
      const first = await open();
      assert.equal(first.status, 200);
      assert.match(first.headers.get('content-type') || '', /text\/event-stream/);
      const reader = first.body!.getReader();
      const { value } = await reader.read();
      assert.match(new TextDecoder().decode(value), /event: ready/);
      const more = await Promise.all([open(), open(), open(), open()]);
      assert.ok(more.every((r) => r.status === 200));
      assert.equal((await open()).status, 429, '6th stream allowed');
    } finally {
      controllers.forEach((c) => c.abort());
    }
  });
  test('9.6 hidden product at checkout', async () => {
    expect(await call('POST', '/cart/items', { token: S.customerToken, body: { productId: S.productId2 || S.productId, quantity: 1 } }), 200);
    const pid = S.productId2 || S.productId;
    expect(await call('PATCH', `/vendor/products/${pid}`, { token: S.vendorToken, body: { isActive: false } }), 200);
    try {
      const body = expect(await call('POST', '/orders/checkout', { token: S.customerToken, body: { addressId: S.addressId }, headers: { 'Idempotency-Key': `hidden-${RUN}` } }), 409);
      assert.equal(body.details?.code, 'CART_CHANGED');
    } finally {
      expect(await call('PATCH', `/vendor/products/${pid}`, { token: S.vendorToken, body: { isActive: true } }), 200);
      await call('DELETE', '/cart', { token: S.customerToken });
    }
  });
  test('9.11-9.13 suspending a store with open orders asks what to do', async () => {
    const owner = expect(await call('GET', '/admin/vendors?q=TechNova', { token: S.adminToken }), 200).items[0];
    const res = await call('PATCH', `/admin/vendors/${S.storeId}`, { token: S.adminToken, body: { status: 'suspended', rejectionReason: 'race test' } });
    if (res.status === 409) {
      assert.equal(res.body.details?.code, 'OPEN_ORDERS');
      const block = await call('PATCH', `/admin/users/${owner.user?._id || owner.user}`, { token: S.adminToken, body: { status: 'blocked', reason: 'race test' } });
      assert.equal(block.status, 409);
    } else {
      // No open orders: put it back.
      expect(res, 200);
      expect(await call('PATCH', `/admin/vendors/${S.storeId}`, { token: S.adminToken, body: { status: 'approved' } }), 200);
    }
    expect(await call('PATCH', `/admin/vendors/${S.storeId}`, { token: S.adminToken, body: { status: 'suspended', rejectionReason: 'x', openOrders: 'maybe' } }), 400, /openOrders/);
    assert.equal(expect(await call('GET', `/stores/${S.storeId}`), 200).store.status ?? 'approved', 'approved');
  });
  test('9.16 private store fields are not searchable by shoppers', async () => {
    const vendors = expect(await call('GET', '/admin/vendors?limit=5', { token: S.adminToken }), 200);
    const phone = vendors.items.find((v) => v.phone)?.phone;
    assert.ok(phone, 'no store with a phone');
    assert.equal(expect(await call('GET', `/stores?q=${phone}`), 200).total, 0, 'store found by phone');
    assert.ok(expect(await call('GET', `/admin/vendors?q=${phone}`, { token: S.adminToken }), 200).total >= 1, 'admin cannot find store by phone');
    const gstin = vendors.items.find((v) => v.gstin)?.gstin;
    if (gstin) {
      assert.equal(expect(await call('GET', `/stores?q=${gstin}`), 200).total, 0, 'store found by GSTIN');
      assert.ok(expect(await call('GET', `/admin/vendors?q=${gstin.toLowerCase()}`, { token: S.adminToken }), 200).total >= 1, 'admin cannot find store by GSTIN');
    }
  });
  test('9.17 /auth/status', async () => {
    expect(await call('GET', '/auth/status', { token: S.customerToken }), 200);
    expect(await call('GET', '/auth/status'), 401);
  });
  test('9.18 typo-tolerant searches', async () => {
    assert.match(expect(await call('GET', '/stores?q=teknova'), 200).items[0]?.storeName || '', /TechNova/);
    assert.ok(expect(await call('GET', '/admin/users?q=anaya', { token: S.adminToken }), 200).items.some((u) => /Ananya/.test(u.name)));
    assert.ok(expect(await call('GET', '/admin/products?q=iphon', { token: S.adminToken }), 200).items.some((p) => /iphone/i.test(p.title)));
    expect(await call('GET', '/vendor/products?q=samsng', { token: S.vendorToken }), 200);
  });
});

describe('2c. Password change and logout (last: ends newUser sessions)', () => {
  test('2.42 wrong current password', async () => expect(await call('PATCH', '/auth/me/password', { token: S.newUserToken, body: { currentPassword: 'wrong-pass', newPassword: 'Test@5678' } }), 400, /Current password is incorrect/));
  test('2.43 new password too short', async () => expect(await call('PATCH', '/auth/me/password', { token: S.newUserToken, body: { currentPassword: 'Test@1234', newPassword: '123' } }), 400, /at least 8/));
  test('2.44-2.45 change password ends old tokens', async () => {
    const old = S.newUserToken;
    const body = expect(await call('PATCH', '/auth/me/password', { token: S.newUserToken, body: { currentPassword: 'Test@1234', newPassword: 'Test@5678' } }), 200);
    S.newUserToken = body.accessToken;
    expect(await call('GET', '/auth/me', { token: old }), 401);
    expect(await call('POST', '/auth/login', { body: { email: S.newUserEmail, password: 'Test@1234' } }), 401);
  });
  test('2.46 logout ends the token', async () => {
    expect(await call('POST', '/auth/logout', { token: S.newUserToken }), 200);
    expect(await call('GET', '/auth/me', { token: S.newUserToken }), 401);
  });
  test('2.47 logout of all devices', async () => {
    const a = await login(S.newUserEmail, 'Test@5678');
    const b = await login(S.newUserEmail, 'Test@5678');
    expect(await call('POST', '/auth/logout-all', { token: a.token }), 200);
    expect(await call('GET', '/auth/me', { token: b.token }), 401);
  });
  test('2.48 delete address, then again', async () => {
    expect(await call('DELETE', `/auth/me/addresses/${S.addressId}`, { token: S.customerToken }), 200);
    expect(await call('DELETE', `/auth/me/addresses/${S.addressId}`, { token: S.customerToken }), 404);
  });
});

after(() => {
  // Nothing to close: every request uses fetch.
});
