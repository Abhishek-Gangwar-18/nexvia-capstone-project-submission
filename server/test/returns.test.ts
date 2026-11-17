/**
 * Returns: concurrent requests, the race with the payout job, and the payment status after full returns.
 * No database or gateway is touched: model calls are faked per test.
 * Run: pnpm test
 */
import { afterEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const src = (path) => new URL(`../src/${path}`, import.meta.url).href;

mock.module(src('services/payment.ts'), {
  exports: {
    CURRENCY: 'inr',
    gatewayError: (err: any) => err.message,
    createRefund: async () => ({ id: 're_1', status: 'succeeded' }),
    findRefund: async () => null,
    reverseTransfer: async () => ({ ok: true }),
    confirmCapture: async () => ({}),
    connectAvailable: () => false,
    createTransfer: async () => ({ id: 'tr_1' }),
  },
});
mock.module(src('services/search.ts'), {
  exports: {
    indexProducts: () => {},
    removeFromIndex: async () => {},
    // used by services/entitySearch.ts (store and user search); no Elasticsearch in tests
    searchClient: () => null,
    reportSearchError: () => {},
    onSearchRecovered: () => {},
    productIdsMatching: async () => null,
  },
});

const { Order } = await import(src('models/Order.ts'));
const { Return } = await import(src('models/Return.ts'));
const { requestReturn, completeReturn } = await import(src('services/returns.ts'));
const { releasePackagePayout } = await import(src('services/payouts.ts'));
const { settlePaymentStatus } = await import(src('services/refunds.ts'));
const { withPackageLock } = await import(src('services/locks.ts'));
const { cache } = await import(src('services/cache.ts'));
const { ApiError } = await import(src('utils/http.ts'));

const CUSTOMER = { _id: new mongoose.Types.ObjectId() };
const PRODUCT = new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;

/** A paid single-package order delivered yesterday: 2 units of one product, payout waiting for the window. */
function deliveredOrder({ payoutStatus = 'on_hold', returnedQty = 0, refund }: Record<string, any> = {}) {
  return new Order({
    orderNumber: 'VDTEST0002',
    customer: CUSTOMER._id,
    packages: [{
      vendor: new mongoose.Types.ObjectId(),
      storeName: 'Store',
      status: 'delivered',
      subtotal: 200,
      total: 200,
      commissionRate: 10,
      commission: 20,
      vendorEarning: 180,
      items: [{ product: PRODUCT, title: 'Item', price: 100, quantity: 2, total: 200 }],
      payout: { mode: 'manual', status: payoutStatus, releaseAfter: new Date(Date.now() + 6 * DAY) },
      timeline: [{ status: 'delivered', at: new Date(Date.now() - DAY) }],
      returned: { quantity: returnedQty },
      ...(refund ? { refund } : {}),
    }],
    pricing: { subtotal: 200, discount: 0, shipping: 0, total: 200 },
    payment: { provider: 'mock', status: 'paid', paymentId: 'pi_test' },
    status: 'delivered',
  });
}

const request = (order, quantity = 2) => ({
  packageId: String(order.packages[0]._id),
  items: [{ product: String(PRODUCT), quantity }],
  reasonCode: 'damaged',
});

afterEach(() => mock.restoreAll());

describe('return requests', () => {
  test('two requests sent together for the same units: only one is saved, the other gets 409', async () => {
    const order = deliveredOrder();
    mock.method(Order, 'findOne', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return order;
    });
    mock.method(Return, 'aggregate', async () => []);
    const save = mock.method(Return.prototype, 'save', async function save() { return this; });

    const results = await Promise.allSettled([requestReturn(CUSTOMER, order._id, request(order)), requestReturn(CUSTOMER, order._id, request(order))]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
    assert.equal(save.mock.callCount(), 1);
  });

  test('a request is refused once the payout job has claimed the package', async () => {
    const order = deliveredOrder({ payoutStatus: 'releasing' });
    mock.method(Order, 'findOne', async () => order);
    mock.method(Return, 'aggregate', async () => []);
    await assert.rejects(requestReturn(CUSTOMER, order._id, request(order)), (err: any) => err.status === 400);
  });
});

describe('payout job and returns', () => {
  test('while a return request holds the package, the payout job skips it without claiming', async () => {
    const order = deliveredOrder();
    const claim = mock.method(Order, 'findOneAndUpdate', async () => order);
    let release;
    const holding = withPackageLock(String(order.packages[0]._id), () => new Promise((resolve) => (release = resolve)));
    assert.equal(await releasePackagePayout(order._id, order.packages[0]._id), 'skipped');
    assert.equal(claim.mock.callCount(), 0);
    release();
    await holding;
  });

  test('when the lock store is unreachable, the payout job skips the package instead of failing the run', async () => {
    const order = deliveredOrder();
    const claim = mock.method(Order, 'findOneAndUpdate', async () => order);
    mock.method(cache, 'lock', async () => {
      throw new ApiError(503, 'unavailable');
    });
    assert.equal(await releasePackagePayout(order._id, order.packages[0]._id), 'skipped');
    assert.equal(claim.mock.callCount(), 0);
  });

  test('an open return found after the claim puts the payout back on hold', async () => {
    const order = deliveredOrder();
    mock.method(Order, 'findOneAndUpdate', async () => order);
    mock.method(Return, 'exists', async () => ({ _id: 'ret_1' }));
    const setPayout = mock.method(Order, 'updateOne', async () => ({ acknowledged: true }));
    assert.equal(await releasePackagePayout(order._id, order.packages[0]._id), 'held');
    assert.equal(setPayout.mock.calls[0].arguments[1].$set['packages.$.payout.status'], 'on_hold');
  });
});

describe('payment status after returns', () => {
  const processed = { status: 'processed', amount: 200 };

  test('every unit returned and refunded: the payment is refunded and the order stays delivered', () => {
    const order = deliveredOrder({ returnedQty: 2, refund: processed });
    settlePaymentStatus(order);
    order.recomputeStatus();
    assert.equal(order.payment.status, 'refunded');
    assert.equal(order.status, 'delivered');
  });

  test('part of the package returned: the payment stays paid', () => {
    const order = deliveredOrder({ returnedQty: 1, refund: { status: 'processed', amount: 100 } });
    settlePaymentStatus(order);
    assert.equal(order.payment.status, 'paid');
  });

  test('every unit returned but the refund failed: the payment stays paid', () => {
    const order = deliveredOrder({ returnedQty: 2, refund: { status: 'failed', amount: 200 } });
    settlePaymentStatus(order);
    assert.equal(order.payment.status, 'paid');
  });

  test('completing the last return counts its units and marks the payment refunded', async () => {
    const order = deliveredOrder({ refund: processed });
    const ret = { _id: 'ret_1', order: order._id, package: order.packages[0]._id, items: [{ quantity: 2 }], amount: 200, vendorShare: 180 };
    mock.method(Return, 'findOneAndUpdate', async () => ret);
    const inc = mock.method(Order, 'updateOne', async (_filter, update) => {
      order.packages[0].returned.quantity += update.$inc['packages.$.returned.quantity'];
      return { acknowledged: true };
    });
    mock.method(Order, 'findById', async () => order);
    const save = mock.method(order, 'save', async () => order);

    await completeReturn('ret_1');
    assert.equal(inc.mock.calls[0].arguments[1].$inc['packages.$.returned.quantity'], 2);
    assert.equal(order.payment.status, 'refunded');
    assert.equal(save.mock.callCount(), 1);
  });
});
