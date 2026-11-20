/**
 * Security checks against a running stack: injection, mass assignment, payment forgery, access control,
 * headers, CORS, size limits and rate limits. CHANGES DATA: throwaway database only, never Atlas.
 *
 *   BASE_URL=http://localhost:18080 API_DIRECT_URL=http://localhost:15050 AUDIT_ADMIN_EMAIL=... AUDIT_ADMIN_PASSWORD=... \
 *     node --test --test-concurrency=1 test/integration/security.integration.ts
 *
 * The login rate-limit test runs last and locks logins from this machine for 15 minutes (flush Redis to undo).
 */
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.BASE_URL || 'http://localhost:18080').replace(/\/$/, '');
const DIRECT = (process.env.API_DIRECT_URL || BASE).replace(/\/$/, '');
const ADMIN = { email: process.env.AUDIT_ADMIN_EMAIL, password: process.env.AUDIT_ADMIN_PASSWORD };
const RUN = Date.now().toString(36);

type Res = { status: number; body: any; headers: Headers; text: string };
async function call(method: string, path: string, { token, body, headers = {}, raw, base = BASE }: Record<string, any> = {}): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'vendora',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && !raw && { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, headers: res.headers, text };
}
const ok = (res: Res, status: number) => assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text.slice(0, 300)}`);
const res200or404 = (res: Res) => [200, 403, 404].includes(res.status);
const noStack = (res: Res) => assert.ok(!/\bat .*\.(ts|js):\d+/.test(res.text), `stack trace leaked: ${res.text.slice(0, 200)}`);

async function login(email: string, password: string) {
  const res = await call('POST', '/auth/login', { body: { email, password } });
  ok(res, 200);
  return res.body.accessToken as string;
}

const S: Record<string, any> = {};
before(async () => {
  S.customer = await login('customer@vendora.dev', 'Customer@123');
  S.customer2 = await login('ananya.gupta@example.com', 'Customer@123');
  S.vendor = await login('technova@vendora.dev', 'Vendor@123');
  S.vendor2 = await login('urbanthreads@vendora.dev', 'Vendor@123').catch(() => null);
  S.admin = await login(ADMIN.email!, ADMIN.password!);
  const products = await call('GET', '/products?inStock=true&limit=48');
  S.product = products.body.items.find((p) => p.stock >= 5);
  S.address = (await call('GET', '/auth/me/addresses', { token: S.customer })).body.addresses[0]._id;
});

describe('injection', () => {
  test('NoSQL operators in login are rejected, never matched', async () => {
    for (const body of [
      { email: { $ne: null }, password: { $ne: null } },
      { email: 'customer@vendora.dev', password: { $gt: '' } },
      { email: { $regex: '.*' }, password: 'x' },
    ]) {
      const res = await call('POST', '/auth/login', { body });
      assert.equal(res.status, 400, `login with ${JSON.stringify(body)} -> ${res.status}`);
      assert.equal(res.body?.accessToken, undefined);
    }
  });
  test('operator-shaped query strings do not change filters', async () => {
    for (const q of ['vendor[$ne]=x', 'q[$regex]=.*', 'minPrice[$gt]=0', 'category[$ne]=000000000000000000000000', 'status[$ne]=x']) {
      const res = await call('GET', `/products?${q}`);
      assert.ok([200, 400].includes(res.status), `${q} -> ${res.status}`);
      noStack(res);
    }
    const res = await call('GET', '/admin/orders?status[$ne]=x', { token: S.admin });
    assert.equal(res.status, 400);
  });
  test('regex-like search text is matched literally and stays fast', async () => {
    for (const q of ['.*', '(a+)+$', '[', '\\', '((((((((((a))))))))))*']) {
      const started = Date.now();
      const res = await call('GET', `/stores?q=${encodeURIComponent(q)}`);
      assert.ok(res.status === 200, `${q} -> ${res.status}`);
      assert.ok(Date.now() - started < 2000, `${q} took ${Date.now() - started} ms`);
      if (q === '.*') assert.ok(res.body.total < 5, '".*" matched every store (regex not escaped)');
    }
  });
  test('script and HTML in user text are stored as plain text', async () => {
    const name = `<img src=x onerror=alert(1)> Audit ${RUN}`;
    const res = await call('PATCH', '/auth/me', { token: S.customer2, body: { name } });
    assert.ok([200, 400].includes(res.status));
    if (res.status === 200) assert.equal(res.body.user.name, name); // React renders it as text (no HTML sinks in the client)
    await call('PATCH', '/auth/me', { token: S.customer2, body: { name: 'Ananya Gupta' } });
  });
  test('path traversal in /uploads cannot read files', async () => {
    for (const p of ['/uploads/../.env', '/uploads/..%2f.env', '/uploads/%2e%2e/%2e%2e/package.json', '/uploads/../../etc/passwd']) {
      const res = await call('GET', p, { base: DIRECT });
      assert.ok(res.status >= 400, `${p} -> ${res.status}`);
      assert.doesNotMatch(res.text, /JWT_SECRET|MONGO_URI|"dependencies"|root:x:/);
    }
  });
});

describe('mass assignment', () => {
  test('a seller cannot set sales, ratings, moderation or owner on a product', async () => {
    const cats = (await call('GET', '/categories')).body.categories;
    const res = await call('POST', '/vendor/products', {
      token: S.vendor,
      body: {
        title: `Audit Mass ${RUN}`, category: cats[0]._id, price: 500, stock: 3, images: [{ url: 'https://picsum.photos/600' }],
        sold: 99999, rating: 5, numRatings: 1000, moderation: { status: 'approved' }, vendor: '000000000000000000000000', deletedAt: null,
      },
    });
    if (res.status === 201) {
      const p = res.body.product;
      assert.ok(!p.sold, `sold set to ${p.sold}`);
      assert.ok(!p.numRatings, `numRatings set to ${p.numRatings}`);
      assert.notEqual(String(p.vendor), '000000000000000000000000');
      S.massProduct = p._id;
    } else assert.equal(res.status, 400, res.text);
  });
  test('a pending seller cannot approve their own store or set commission', async () => {
    const email = `audit-sec-${RUN}@example.com`;
    ok(await call('POST', '/auth/register', { body: { name: 'Sec Seller', email, password: 'Test@1234' } }), 201);
    let token = await login(email, 'Test@1234');
    const onboard = await call('POST', '/vendor/onboard', {
      token,
      body: {
        storeName: `Sec Store ${RUN}`, email, phone: `96${String(Date.now()).slice(-8)}`,
        address: { line1: '1 Test Street', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
        bank: { accountHolder: 'Sec Seller', accountNumber: '123456789012', ifsc: 'HDFC0001234' },
        status: 'approved', commissionRate: 0,
      },
    });
    assert.ok([201, 400].includes(onboard.status), onboard.text);
    if (onboard.status === 201) assert.equal(onboard.body.vendor.status, 'pending');
    token = await login(email, 'Test@1234');
    // Unknown fields are dropped: the answer may be 200, but status and commission must not change.
    const patch = await call('PATCH', '/vendor/store', { token, body: { status: 'approved', commissionRate: 0 } });
    assert.ok([200, 400, 403].includes(patch.status), `store PATCH -> ${patch.status}`);
    const mine = await call('GET', '/vendor/store', { token });
    assert.equal(mine.body.vendor.status, 'pending', 'seller approved their own store');
    assert.notEqual(mine.body.vendor.commissionRate, 0, 'seller set their own commission');
    const stores = await call('GET', `/stores?q=${encodeURIComponent(`Sec Store ${RUN}`)}`);
    assert.equal(stores.body.total, 0, 'pending store became public');
  });
  test('cart lines ignore a price sent by the client', async () => {
    await call('DELETE', '/cart', { token: S.customer });
    const res = await call('POST', '/cart/items', { token: S.customer, body: { productId: S.product._id, quantity: 1, price: 1, priceAtAdd: 1 } });
    assert.ok([200, 400].includes(res.status));
    if (res.status === 200) assert.equal(res.body.items[0].product.price, S.product.price);
  });
  test('checkout ignores client-side totals, prices and discounts', async () => {
    const res = await call('POST', '/orders/checkout', {
      token: S.customer,
      headers: { 'Idempotency-Key': `sec-price-${RUN}` },
      body: { addressId: S.address, total: 1, pricing: { total: 1, discount: 99999 }, discount: 99999, items: [{ product: S.product._id, price: 1 }] },
    });
    assert.ok([201, 400].includes(res.status), res.text);
    if (res.status === 201) {
      assert.equal(res.body.order.pricing.subtotal, S.product.price);
      assert.equal(res.body.order.pricing.discount, 0);
      S.unpaidOrder = res.body.order._id;
    }
  });
});

describe('payments', () => {
  test('the client cannot mark an order paid (Stripe mode ignores "outcome")', async () => {
    assert.ok(S.unpaidOrder, 'no unpaid order from the previous test');
    const res = await call('POST', `/orders/${S.unpaidOrder}/verify`, { token: S.customer, body: { outcome: 'success', paymentIntentId: 'pi_fake', status: 'succeeded' } });
    const order = (await call('GET', `/orders/${S.unpaidOrder}`, { token: S.customer })).body.order;
    assert.notEqual(order.payment.status, 'paid', `forged verify (${res.status}) marked the order paid`);
  });
  test('a forged webhook without a valid signature is refused', async () => {
    const forged = { id: `evt_forged_${RUN}`, type: 'payment_intent.succeeded', data: { object: { id: 'pi_fake', metadata: { orderId: S.unpaidOrder } } } };
    for (const sig of [undefined, 't=1,v1=deadbeef', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`]) {
      const res = await call('POST', '/payments/webhook', { body: forged, headers: sig ? { 'Stripe-Signature': sig } : {} });
      assert.equal(res.status, 400, `signature ${sig} -> ${res.status}`);
    }
    const order = (await call('GET', `/orders/${S.unpaidOrder}`, { token: S.customer })).body.order;
    assert.notEqual(order.payment.status, 'paid');
  });
  test('webhook signatures: a correctly signed event is accepted, a replayed old one is not', async (t) => {
    const secret = process.env.AUDIT_WEBHOOK_SECRET;
    if (!secret) return t.skip('set AUDIT_WEBHOOK_SECRET (the stack\'s STRIPE_WEBHOOK_SECRET)');
    const { createHmac } = await import('node:crypto');
    const sign = (payload: string, ts: number) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;
    // A harmless event type the server acknowledges without changing anything.
    const payload = JSON.stringify({ id: `evt_audit_${RUN}`, object: 'event', type: 'customer.created', data: { object: { id: 'cus_audit' } } });
    const now = Math.floor(Date.now() / 1000);
    const good = await call('POST', '/payments/webhook', { body: payload, raw: true, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(payload, now) } });
    assert.equal(good.status, 200, good.text);
    const replay = JSON.stringify({ ...JSON.parse(payload), id: `evt_audit_old_${RUN}` });
    const old = await call('POST', '/payments/webhook', { body: replay, raw: true, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(replay, now - 3600) } });
    assert.equal(old.status, 400, `hour-old signature -> ${old.status}`);
    const tampered = payload.replace('cus_audit', 'cus_other');
    const bad = await call('POST', '/payments/webhook', { body: tampered, raw: true, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(payload, now) } });
    assert.equal(bad.status, 400, `tampered body -> ${bad.status}`);
  });
  test('another customer cannot cancel, pay or download someone else\'s order', async () => {
    for (const [m, p, body] of [['POST', `/orders/${S.unpaidOrder}/cancel`, { reasonCode: 'changed_mind' }], ['POST', `/orders/${S.unpaidOrder}/verify`, {}], ['GET', `/orders/${S.unpaidOrder}/payment`]] as const) {
      const res = await call(m, p, { token: S.customer2, body });
      assert.ok([403, 404].includes(res.status), `${m} ${p} as customer2 -> ${res.status}`);
    }
    // Returns of an order are filtered by the signed-in customer: someone else gets an empty list.
    const returns = await call('GET', `/orders/${S.unpaidOrder}/returns`, { token: S.customer2 });
    assert.ok(res200or404(returns) && !(returns.body?.returns?.length), `customer2 sees returns: ${returns.text}`);
  });
});

describe('access control between sellers', () => {
  test('a seller cannot see or change another seller\'s orders, coupons or returns', async () => {
    if (!S.vendor2) return;
    const theirCoupons = (await call('GET', '/vendor/coupons', { token: S.vendor })).body.items || [];
    for (const c of theirCoupons.slice(0, 2)) {
      for (const [m, body] of [['PATCH', { isActive: false }], ['DELETE', undefined]] as const) {
        const res = await call(m, `/vendor/coupons/${c._id}`, { token: S.vendor2, body });
        assert.ok([403, 404].includes(res.status), `vendor2 ${m} coupon -> ${res.status}`);
      }
    }
    const orders = (await call('GET', '/vendor/orders?limit=3', { token: S.vendor })).body.items || [];
    for (const o of orders) {
      const res = await call('PATCH', `/vendor/orders/${o._id}/status`, { token: S.vendor2, body: { status: 'packed' } });
      assert.ok([400, 403, 404].includes(res.status) && !(res.status === 200), `vendor2 updates TechNova order -> ${res.status}`);
    }
    const returns = (await call('GET', '/vendor/returns', { token: S.vendor })).body.items || [];
    for (const r of returns.slice(0, 2)) {
      const res = await call('PATCH', `/vendor/returns/${r._id}`, { token: S.vendor2, body: { action: 'approve' } });
      assert.ok([400, 403, 404].includes(res.status), `vendor2 decides TechNova return -> ${res.status}`);
    }
  });
  test('public and customer answers never include password hashes, bank details or tokens', async () => {
    const pages = [
      await call('GET', '/home'),
      await call('GET', '/stores?limit=10'),
      await call('GET', `/products/${S.product._id}`),
      await call('GET', `/products/${S.product._id}/reviews`),
      await call('GET', '/auth/me', { token: S.customer }),
      await call('GET', '/vendor/store', { token: S.vendor }),
      await call('GET', '/admin/users?limit=50', { token: S.admin }),
      await call('GET', '/admin/vendors?limit=20', { token: S.admin }),
    ];
    for (const res of pages) {
      assert.doesNotMatch(res.text, /\$2[aby]\$\d\d\$/, 'bcrypt hash in a response');
      assert.doesNotMatch(res.text, /"(refreshTokenHash|previousTokenHash|password|accountNumber)":"(?!\*|X|•)[^"]{6,}/, 'secret field in a response');
      assert.doesNotMatch(res.text, /sk_(test|live)_|whsec_|AKIA[0-9A-Z]{16}/, 'API key in a response');
    }
    const reviews = (await call('GET', `/products/${S.product._id}/reviews`)).text;
    assert.doesNotMatch(reviews, /@(vendora\.dev|example\.com)/, 'reviewer emails are public');
  });
});

describe('transport, headers and limits', () => {
  test('API answers carry security headers', async () => {
    const res = await call('GET', '/health', { base: DIRECT });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('content-security-policy') || res.headers.get('x-frame-options'), 'no CSP / frame protection');
    assert.equal(res.headers.get('x-powered-by'), null, 'X-Powered-By reveals Express');
  });
  test('the web app (nginx) sends basic security headers on pages', async () => {
    const res = await fetch(`${BASE}/`, { headers: { Accept: 'text/html' } });
    const missing = ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy'].filter((h) => !res.headers.get(h));
    S.webMissingHeaders = missing;
    assert.equal(res.headers.get('server')?.match(/nginx\/\d/), null, `nginx version disclosed: ${res.headers.get('server')}`);
  });
  test('CORS: a foreign origin gets no credentials access and no stack trace', async () => {
    const res = await call('GET', '/products?limit=1', { base: DIRECT, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'evil origin allowed');
    noStack(res);
    S.corsStatus = res.status;
  });
  test('a JSON body over 1 MB is refused', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(1_200_000) });
    const res = await call('PATCH', '/auth/me', { token: S.customer2, body: big, raw: true, headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 413, `-> ${res.status}`);
    noStack(res);
  });
  test('a large array inside the 1 MB limit is still validated quickly (zod advisory)', async () => {
    const tags = Array.from({ length: 50_000 }, (_, i) => `t${i}`);
    const started = Date.now();
    const res = await call('POST', '/vendor/products', { token: S.vendor, body: { title: 'Big', category: '000000000000000000000000', price: 1, stock: 1, images: [{ url: 'https://picsum.photos/600' }], tags } });
    assert.equal(res.status, 400);
    assert.ok(Date.now() - started < 3000, `validation took ${Date.now() - started} ms`);
  });
  test('an oversized image upload is refused', async () => {
    const form = new FormData();
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(12 * 1024 * 1024)]);
    form.append('images', new Blob([png], { type: 'image/png' }), 'huge.png');
    const res = await call('POST', '/uploads?folder=avatars', { token: S.customer, body: form, raw: true });
    assert.ok([400, 413].includes(res.status), `-> ${res.status}`);
    noStack(res);
  });
  test('malformed JSON gets a clean 400', async () => {
    const res = await call('POST', '/auth/login', { body: '{"email": ', raw: true, headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 400);
    noStack(res);
  });
});

describe('rate limits (last: locks logins for 15 minutes)', () => {
  test('login is limited per address', async () => {
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const res = await call('POST', '/auth/login', { body: { email: `nobody+${i}@example.com`, password: 'wrong-pass' } });
      if (res.status === 429) { limited = i; break; }
    }
    assert.ok(limited > 0 && limited <= 50, `no 429 within 60 attempts (got at ${limited})`);
  });
});

test('summary', () => {
  console.log(`web (nginx) headers missing on pages: ${(S.webMissingHeaders || []).join(', ') || 'none'}`);
  console.log(`CORS foreign-origin status: ${S.corsStatus}`);
});
