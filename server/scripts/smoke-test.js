/**
 * End-to-end smoke test of the running API (npm run smoke).
 * Walks through the full marketplace flow as guest, customer, vendor and admin.
 */
const BASE = process.env.API_URL || 'http://localhost:5050/api';
let passed = 0;

const check = (condition, label, extra = '') => {
  if (!condition) {
    console.error(`  ✗ ${label} ${extra}`);
    throw new Error(`Smoke test failed at: ${label}`);
  }
  passed += 1;
  console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`);
};

async function call(method, path, { token, body, raw = false, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const login = async (email, password) => {
  const { status, data } = await call('POST', '/auth/login', { body: { email, password } });
  check(status === 200 && data.token, `login ${email}`, data.user?.role);
  return data.token;
};

async function main() {
  console.log(`\nSmoke testing ${BASE}\n`);

  console.log('Public catalog');
  const health = await call('GET', '/health');
  check(health.status === 200, 'health', JSON.stringify(health.data.services));
  const home = await call('GET', '/home');
  check(home.data.trending?.length > 0 && home.data.categories?.length > 0, 'home feed', `${home.data.trending.length} trending, ${home.data.vendors.length} stores`);
  const search = await call('GET', '/products?q=phone&sort=price_asc&limit=5');
  check(search.data.total > 0, 'search "phone"', `${search.data.total} hits via ${search.data.engine}`);
  const prices = search.data.items.map((p) => p.price);
  check(prices.every((p, i) => i === 0 || p >= prices[i - 1]), 'search sorted by price asc');
  const faceted = await call('GET', '/products?category=smartphones&minPrice=10000&inStock=1');
  check(faceted.data.items.every((p) => p.category === 'smartphones' && p.price >= 10000), 'category + price filters', `${faceted.data.total} results`);
  check(faceted.data.facets.brands.length > 0, 'brand facets', faceted.data.facets.brands.map((b) => b.key).slice(0, 4).join(', '));
  const suggest = await call('GET', '/products/suggest?q=iph');
  check(suggest.data.products.length > 0, 'typeahead suggestions', suggest.data.products[0]?.title);
  const detail = await call('GET', `/products/${home.data.trending[0]._id}`);
  check(detail.status === 200 && detail.data.product.vendor.storeName, 'product detail', `${detail.data.product.title} by ${detail.data.product.vendor.storeName}`);
  const reviews = await call('GET', `/products/${detail.data.product._id}/reviews`);
  check(reviews.data.total > 0, 'reviews + distribution', JSON.stringify(reviews.data.distribution));
  const store = await call('GET', `/stores/${detail.data.product.vendor._id}`);
  check(store.status === 200, 'store page', `${store.data.store.stats.products} products`);
  const coupons = await call('GET', '/coupons');
  check(coupons.data.coupons.length > 0, 'public coupons', coupons.data.coupons.map((c) => c.code).join(', '));

  console.log('\nCustomer journey');
  const customer = await login('customer@vendora.dev', 'Customer@123');
  const me = await call('GET', '/auth/me', { token: customer });
  const addressId = me.data.user.addresses[0]._id;
  let cart = await call('GET', '/cart', { token: customer });
  check(cart.status === 200, 'cart loads (Redis cache -> Mongo)', `${cart.data.items.length} items`);
  await call('DELETE', '/cart', { token: customer });
  const phone = faceted.data.items[0];
  const glow = (await call('GET', '/products?category=beauty&limit=2')).data.items[0];
  cart = await call('POST', '/cart/items', { token: customer, body: { productId: phone._id, quantity: 1 } });
  cart = await call('POST', '/cart/items', { token: customer, body: { productId: glow._id, quantity: 2 } });
  check(cart.data.items.length === 2, 'add 2 products from 2 vendors');
  cart = await call('PATCH', `/cart/items/${glow._id}`, { token: customer, body: { quantity: 3 } });
  check(cart.data.items.find((i) => i.productId === glow._id).quantity === 3, 'update quantity');
  const coupon = await call('POST', '/cart/coupon', { token: customer, body: { code: 'FLAT250' } });
  check(coupon.status === 200 && coupon.data.coupon.discount === 250, 'apply coupon FLAT250', `total ${coupon.data.summary.total}`);
  const badCoupon = await call('POST', '/cart/coupon', { token: customer, body: { code: 'MONSOON30' } });
  check(badCoupon.status === 400, 'expired coupon rejected', badCoupon.data.message);

  const checkout = await call('POST', '/orders/checkout', { token: customer, body: { addressId, couponCode: 'FLAT250' } });
  check(checkout.status === 201, 'checkout creates order', `${checkout.data.order?.orderNumber} via ${checkout.data.payment?.provider}`);
  const orderId = checkout.data.order._id;
  const declined = await call('POST', `/orders/${orderId}/verify`, { token: customer, body: { outcome: 'failure' } });
  check(declined.status === 402, 'declined payment keeps order retryable');
  const paid = await call('POST', `/orders/${orderId}/verify`, { token: customer, body: { outcome: 'success' } });
  check(paid.data.order?.payment.status === 'paid', 'payment verified', paid.data.order?.status);
  const order = (await call('GET', `/orders/${orderId}`, { token: customer })).data.order;
  check(order.packages.length === 2, 'order split into 2 vendor packages');
  order.packages.forEach((p) =>
    check(Math.abs(p.commission + p.vendorEarning - p.total) < 0.01, `commission split ${p.storeName}`, `total ${p.total} = vendor ${p.vendorEarning} + platform ${p.commission} (${p.commissionRate}%)`),
  );
  const packageSum = order.packages.reduce((s, p) => s + p.total, 0) + order.pricing.shipping;
  check(Math.abs(packageSum - order.pricing.total) < 0.01, 'packages + shipping = order total', String(order.pricing.total));
  cart = await call('GET', '/cart', { token: customer });
  check(cart.data.items.length === 0, 'cart cleared after payment');
  const invoice = await call('GET', `/orders/${orderId}/invoice`, { token: customer, raw: true });
  const pdf = Buffer.from(await invoice.arrayBuffer());
  check(invoice.headers.get('content-type') === 'application/pdf' && pdf.subarray(0, 4).toString() === '%PDF', 'PDF invoice', `${pdf.length} bytes`);

  console.log('\nVendor fulfilment');
  const vendor = await login('technova@vendora.dev', 'Vendor@123');
  const pkg = order.packages.find((p) => p.storeName === 'TechNova Electronics');
  for (const status of ['packed', 'shipped', 'delivered']) {
    const res = await call('PATCH', `/vendor/orders/${orderId}/status`, { token: vendor, body: { status } });
    check(res.status === 200, `package -> ${status}`);
  }
  const invalid = await call('PATCH', `/vendor/orders/${orderId}/status`, { token: vendor, body: { status: 'packed' } });
  check(invalid.status === 400, 'illegal transition rejected', invalid.data.message);
  const afterDelivery = (await call('GET', `/orders/${orderId}`, { token: customer })).data.order;
  check(afterDelivery.packages.find((p) => p._id === pkg._id).payout.status === 'released', 'vendor payout released on delivery');

  const review = await call('POST', `/products/${pkg.items[0].product}/reviews`, { token: customer, body: { rating: 5, title: 'Smoke test', comment: 'Great product, arrived quickly and works well.' } });
  check(review.status === 201 && review.data.review.verified, 'verified-purchase review');

  const dash = await call('GET', '/vendor/dashboard', { token: vendor });
  check(dash.status === 200, 'vendor dashboard', `30d revenue ₹${dash.data.kpis.revenue.value}, ${dash.data.series.length} chart points`);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('images', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const upload = await call('POST', '/uploads?folder=products', { token: vendor, form });
  check(upload.status === 201, 'image upload', upload.data.files?.[0]?.url);
  const created = await call('POST', '/vendor/products', {
    token: vendor,
    body: { title: 'Smoke Test Wireless Earbuds', description: 'Test product', brand: 'TechNova', category: 'mobile-accessories', price: 1999, mrp: 2999, stock: 25, images: upload.data.files, tags: ['audio'] },
  });
  check(created.status === 201, 'vendor creates product', created.data.product?._id);
  const found = await call('GET', '/products?q=smoke%20test%20earbuds');
  check(found.data.items.some((p) => p._id === created.data.product._id), 'new product is searchable', found.data.engine);
  const updated = await call('PUT', `/vendor/products/${created.data.product._id}`, { token: vendor, body: { price: 1799, stock: 10 } });
  check(updated.data.product?.price === 1799, 'vendor updates product');
  const removed = await call('DELETE', `/vendor/products/${created.data.product._id}`, { token: vendor });
  check(removed.status === 200, 'vendor deletes product');
  const vendorOrders = await call('GET', '/vendor/orders', { token: vendor });
  check(vendorOrders.status === 200, 'vendor order list', `${vendorOrders.data.total} packages`);
  const payouts = await call('GET', '/vendor/payouts', { token: vendor });
  check(payouts.status === 200, 'vendor payouts ledger', JSON.stringify(Object.keys(payouts.data.summary)));
  const forbidden = await call('GET', '/admin/analytics', { token: vendor });
  check(forbidden.status === 403, 'RBAC: vendor blocked from admin API');

  // No admin is seeded; pass your own admin login to include these checks.
  const { SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD } = process.env;
  if (SMOKE_ADMIN_EMAIL && SMOKE_ADMIN_PASSWORD) {
    console.log('\nAdmin');
    const admin = await login(SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD);
    const analytics = await call('GET', '/admin/analytics?range=30', { token: admin });
    check(analytics.status === 200, 'admin analytics', `GMV ₹${analytics.data.kpis.gmv.value}, commission ₹${analytics.data.kpis.commission.value}`);
    const vendors = await call('GET', '/admin/vendors', { token: admin });
    check(vendors.data.items?.length > 0, 'vendor directory', vendors.data.items.map((v) => v.storeName).join(', '));
    const system = await call('GET', '/admin/system', { token: admin });
    check(system.status === 200, 'system status', JSON.stringify(system.data));
  } else {
    console.log('\nAdmin checks skipped (set SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD to include them)');
  }

  console.log('\nCancellation + refund');
  await call('POST', '/cart/items', { token: customer, body: { productId: glow._id, quantity: 1 } });
  const second = await call('POST', '/orders/checkout', { token: customer, body: { addressId } });
  await call('POST', `/orders/${second.data.order._id}/verify`, { token: customer, body: { outcome: 'success' } });
  const cancelled = await call('POST', `/orders/${second.data.order._id}/cancel`, { token: customer, body: {} });
  check(cancelled.data.order?.status === 'cancelled' && cancelled.data.order.payment.status === 'refunded', 'customer cancels -> refunded');

  console.log('\nSessions');
  await call('POST', '/auth/logout', { token: customer });
  const afterLogout = await call('GET', '/auth/me', { token: customer });
  check(afterLogout.status === 401, 'logout revokes token (Redis session)');

  console.log(`\nAll ${passed} checks passed ✔\n`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
