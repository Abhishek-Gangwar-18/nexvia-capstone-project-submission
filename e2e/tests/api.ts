import { expect, type APIRequestContext } from '@playwright/test';

const HEADERS = { Accept: 'application/json', 'X-Requested-With': 'vendora' };

/** A fresh API session (its own cookie jar), for setting up data the UI test then works with. */
export async function apiLogin(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/auth/login', { data: { email, password }, headers: HEADERS });
  expect(res.status(), `login ${email}`).toBe(200);
  const { accessToken } = await res.json();
  const call = async (method: string, path: string, data?: unknown, extra: Record<string, string> = {}) => {
    const r = await request.fetch(path, { method, data, headers: { ...HEADERS, Authorization: `Bearer ${accessToken}`, ...extra } });
    const body = await r.json().catch(() => null);
    return { status: r.status(), body };
  };
  return { call, token: accessToken };
}

/** A paid order for one in-stock product of the given store, placed by the given customer. Returns its id. */
export async function paidOrderFor(request: APIRequestContext, customer: { email: string; password: string }, storeName: RegExp) {
  const api = await apiLogin(request, customer.email, customer.password);
  const stores = await api.call('GET', '/stores?limit=20');
  const store = stores.body.items.find((s) => storeName.test(s.storeName));
  const products = await api.call('GET', `/products?vendor=${store._id}&inStock=true&limit=5`);
  const product = products.body.items.find((p) => p.stock >= 3);
  await api.call('DELETE', '/cart');
  expect((await api.call('POST', '/cart/items', { productId: product._id, quantity: 1 })).status).toBe(200);
  const addresses = await api.call('GET', '/auth/me/addresses');
  const order = await api.call('POST', '/orders/checkout', { addressId: addresses.body.addresses[0]._id }, { 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  const paid = await api.call('POST', `/orders/${order.body.order._id}/verify`, { outcome: 'success' });
  expect(paid.status).toBe(200);
  return { orderId: order.body.order._id as string, orderNumber: order.body.order.orderNumber as string };
}
