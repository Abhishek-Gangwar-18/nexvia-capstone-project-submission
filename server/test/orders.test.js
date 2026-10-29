/**
 * Package lifecycle, refunds on cancel, payout reversal and the package lock.
 * No database or gateway is touched: Stripe, search, stock writes and the Refund/Payment models are faked.
 * Run: pnpm test
 */
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const src = (path) => new URL(`../src/${path}`, import.meta.url).href;

let refundShouldFail = false;
let reversalShouldFail = false;
/** What Stripe already has for a refund id (simulates "the refund went through but the response was lost"). */
let stripeHasRefund = null;
const refundCalls = [];
mock.module(src('services/payment.js'), {
  exports: {
    CURRENCY: 'inr',
    gatewayError: (err) => err.message,
    createRefund: async ({ amount }) => {
      refundCalls.push(amount);
      if (refundShouldFail) throw new Error('gateway timeout (simulated)');
      return { id: `re_${refundCalls.length}`, status: 'succeeded', providerStatus: 'succeeded' };
    },
    findRefund: async () => stripeHasRefund,
    reverseTransfer: async () => (reversalShouldFail ? { ok: false, error: 'transfer already paid out (simulated)' } : { ok: true }),
    confirmCapture: async () => ({ method: 'card', chargeId: 'ch_1' }),
    connectAvailable: () => false,
    createTransfer: async () => ({ id: 'tr_1' }),
  },
});
mock.module(src('services/search.js'), {
  exports: { indexProducts: () => {}, removeFromIndex: async () => {} },
});

// In-memory Refund and Payment models: refunds.js writes a Refund before calling the gateway.
const refundStore = [];
class FakeRefund {
  constructor(data) {
    Object.assign(this, { _id: new mongoose.Types.ObjectId(), status: 'pending', attempts: 0, createdAt: new Date(), updatedAt: new Date() }, data);
  }

  async save() {
    this.updatedAt = new Date();
    return this;
  }

  static async create(data) {
    const refund = new FakeRefund(data);
    refundStore.push(refund);
    return refund;
  }

  static async findById(id) {
    return refundStore.find((r) => String(r._id) === String(id)) || null;
  }

  static find(query) {
    const rows = refundStore.filter((r) => String(r.order) === String(query.order) && String(r.package) === String(query.package));
    return { sort: () => ({ lean: async () => rows.map((r) => ({ ...r })) }) };
  }
}
mock.module(src('models/Refund.js'), { exports: { Refund: FakeRefund, REFUND_STATUSES: ['pending', 'succeeded', 'failed'], REFUND_REASONS: [] } });
mock.module(src('models/Payment.js'), {
  exports: { Payment: { findOne: () => ({ select: () => ({ lean: async () => ({ _id: 'pay_1', intentId: 'pi_1' }) }) }) }, PAYMENT_STATUSES: [] },
});

const { Product } = await import(src('models/Product.js'));
const { Order } = await import(src('models/Order.js'));
const { transitionPackage, withPackageLock } = await import(src('services/orders.js'));
const { reversePayout } = await import(src('services/payouts.js'));
const { retryRefund } = await import(src('services/refunds.js'));
const BY_ADMIN = { cancellation: { by: 'admin', reasonCode: 'fraud' } };

const pkg = (status, total) => ({
  vendor: '000000000000000000000001',
  storeName: `Store ${total}`,
  status,
  subtotal: total,
  total,
  commissionRate: 10,
  commission: total * 0.1,
  vendorEarning: total * 0.9,
  items: [{ product: '000000000000000000000009', title: 'Item', price: total, quantity: 1, total }],
  payout: { mode: 'manual', status: 'on_hold' },
  timeline: [],
});

const paidOrder = (...packages) =>
  new Order({
    orderNumber: 'VDTEST0001',
    customer: '000000000000000000000002',
    packages,
    pricing: { subtotal: 300, discount: 0, shipping: 50, total: 350 },
    payment: { provider: 'mock', status: 'paid', paymentId: 'pi_test', intentId: 'pi_test' },
  });

beforeEach(() => {
  refundShouldFail = false;
  reversalShouldFail = false;
  refundCalls.length = 0;
  refundStore.length = 0;
  stripeHasRefund = null;
  mock.method(Product, 'updateOne', async () => ({ acknowledged: true }));
});
afterEach(() => mock.restoreAll());

describe('transition rules', () => {
  for (const from of ['shipped', 'delivered', 'cancelled']) {
    test(`a ${from} package cannot be cancelled, and no refund is attempted`, async () => {
      const order = paidOrder(pkg(from, 100));
      await assert.rejects(transitionPackage(order, order.packages[0], 'cancelled', BY_ADMIN), (err) => err.status === 400);
      assert.equal(refundCalls.length, 0);
    });
  }

  test('a shipped package cannot move back to packed', async () => {
    const order = paidOrder(pkg('shipped', 100));
    await assert.rejects(transitionPackage(order, order.packages[0], 'packed'), (err) => err.status === 400);
  });

  test('delivery schedules the vendor payout after the return window instead of paying at once', async () => {
    const order = paidOrder(pkg('shipped', 100));
    const before = Date.now();
    await transitionPackage(order, order.packages[0], 'delivered');
    const { payout } = order.packages[0];
    assert.equal(payout.status, 'on_hold');
    const days = (payout.releaseAfter.getTime() - before) / (24 * 60 * 60 * 1000);
    assert.ok(days > 6.99 && days < 7.01, `released after ~7 days, got ${days}`);
  });
});

describe('refunds on cancel', () => {
  test('every refund is recorded first, then sent; all succeed: the order is refunded', async () => {
    const order = paidOrder(pkg('placed', 100), pkg('packed', 200));
    await transitionPackage(order, order.packages[0], 'cancelled', BY_ADMIN);
    await transitionPackage(order, order.packages[1], 'cancelled', BY_ADMIN);
    assert.equal(order.payment.status, 'refunded');
    assert.equal(order.status, 'cancelled');
    assert.deepEqual(refundCalls, [100, 250]); // the last package also refunds shipping
    assert.deepEqual(refundStore.map((r) => [r.status, r.attempts, r.reason]), [['succeeded', 1, 'cancellation'], ['succeeded', 1, 'cancellation']]);
  });

  test('a failed refund keeps the payment "paid" and does not overwrite the successful one', async () => {
    const order = paidOrder(pkg('placed', 100), pkg('placed', 200));
    await transitionPackage(order, order.packages[0], 'cancelled', BY_ADMIN);
    refundShouldFail = true;
    await transitionPackage(order, order.packages[1], 'cancelled', BY_ADMIN);

    assert.equal(order.payment.status, 'paid', 'money was not fully returned, so the order must not say refunded');
    assert.equal(order.packages[0].refund.status, 'processed');
    assert.equal(order.packages[0].refund.id, 're_1');
    assert.equal(order.packages[1].refund.status, 'failed');
    assert.match(order.packages[1].refund.error, /simulated/);
    assert.equal(refundStore[1].status, 'failed', 'the failed attempt is kept for a retry');
    assert.ok(order.packages[1].timeline.some((t) => /failed/i.test(t.note)), 'timeline records the failure');
    assert.equal(order.status, 'cancelled');
  });
});

describe('package lock', () => {
  test('a second concurrent update gets 409, and the lock is released afterwards', async () => {
    let release;
    const first = withPackageLock('pkg-1', () => new Promise((resolve) => (release = resolve)));
    await assert.rejects(withPackageLock('pkg-1', async () => 'second'), (err) => err.status === 409);
    release('first');
    assert.equal(await first, 'first');
    assert.equal(await withPackageLock('pkg-1', async () => 'again'), 'again');
  });

  test('the lock is released when the update throws', async () => {
    await assert.rejects(withPackageLock('pkg-2', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await withPackageLock('pkg-2', async () => 'ok'), 'ok');
  });
});

describe('payout reversal', () => {
  test('cancelling a package before payout: nothing was transferred, the payout is reversed', async () => {
    const order = paidOrder(pkg('placed', 100), pkg('placed', 200));
    await transitionPackage(order, order.packages[0], 'cancelled', BY_ADMIN);
    assert.equal(order.packages[0].payout.status, 'reversed');
  });

  test('a released Stripe transfer that cannot be pulled back is never recorded as reversed', async () => {
    reversalShouldFail = true;
    const order = paidOrder({ ...pkg('delivered', 100), payout: { mode: 'stripe', status: 'released', transferId: 'tr_9', amount: 90 } });
    const [released] = order.packages;
    assert.equal(await reversePayout(released), false);
    assert.equal(released.payout.status, 'reversal_failed');
    assert.match(released.payout.reversalError, /already paid out/);
  });
});

describe('refund retry never pays twice', () => {
  test('a retry adopts the refund Stripe already made instead of sending a second one', async () => {
    const order = paidOrder(pkg('placed', 100), pkg('placed', 200));
    mock.method(Order, 'findById', async () => order);
    mock.method(order, 'save', async () => order);
    refundShouldFail = true; // the gateway call errors out (timeout) ...
    await transitionPackage(order, order.packages[0], 'cancelled', BY_ADMIN);
    const [refund] = refundStore;
    assert.equal(refund.status, 'failed');
    assert.equal(refundCalls.length, 1);

    // ... but Stripe did make the refund. The retry finds it by our refund id and sends nothing new.
    refundShouldFail = false;
    stripeHasRefund = { id: 're_lost', status: 'succeeded', providerStatus: 'succeeded' };
    await retryRefund(refund._id);
    assert.equal(refundCalls.length, 1, 'no second refund was sent');
    assert.equal(refund.status, 'succeeded');
    assert.equal(refund.providerRefundId, 're_lost');
    assert.equal(order.packages[0].refund.status, 'processed');
  });

  test('a retry of a refund Stripe never made sends a new attempt', async () => {
    const order = paidOrder(pkg('placed', 100), pkg('placed', 200));
    mock.method(Order, 'findById', async () => order);
    mock.method(order, 'save', async () => order);
    refundShouldFail = true;
    await transitionPackage(order, order.packages[0], 'cancelled', BY_ADMIN);
    refundShouldFail = false;
    await retryRefund(refundStore[0]._id);
    assert.equal(refundCalls.length, 2);
    assert.equal(refundStore[0].attempts, 2);
    assert.equal(refundStore[0].status, 'succeeded');
  });
});

