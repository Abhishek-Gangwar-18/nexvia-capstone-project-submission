/**
 * Coupon holds (per-customer and overall limits taken atomically at checkout, given back on cancel)
 * and Stripe webhook processing (each event handled at most once, retried after a failure).
 * No database or gateway is touched: model calls and the order services are faked.
 * Run: pnpm test
 */
import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const src = (path) => new URL(`../src/${path}`, import.meta.url).href;

const finalized = [];
let finalizeFails = false;
mock.module(src('services/orders.ts'), {
  exports: {
    finalizePayment: async (orderId, opts) => {
      if (finalizeFails) throw new Error('database timeout');
      finalized.push({ orderId: String(orderId), ...opts });
    },
    recordPaymentEvent: async () => {},
    recordPaymentFailure: async () => {},
  },
});
mock.module(src('services/payouts.ts'), { exports: { freezePayoutsIfPending: async () => {} } });
mock.module(src('services/refunds.ts'), { exports: { syncRefundFromProvider: async () => {} } });
mock.module(src('services/payment.ts'), { exports: { refundStatusOf: (s) => s } });
mock.module(src('utils/logger.ts'), { exports: { logger: { error: () => {}, warn: () => {}, info: () => {}, ok: () => {} } } });

const { Coupon } = await import(src('models/Coupon.ts'));
const { CouponRedemption } = await import(src('models/CouponRedemption.ts'));
const { Payment } = await import(src('models/Payment.ts'));
const { WebhookEvent } = await import(src('models/WebhookEvent.ts'));
const { holdCoupon, releaseCoupon } = await import(src('services/coupons.ts'));
const { handleStripeEvent } = await import(src('services/webhooks.ts'));
const { ApiError } = await import(src('utils/http.ts'));

const id = () => new mongoose.Types.ObjectId();
const USER = id();

describe('coupon holds', () => {
  let coupon;
  let redemptions;
  let usedCount;

  beforeEach(() => {
    coupon = { _id: id(), perUserLimit: 2, usageLimit: 3, isActive: true };
    redemptions = [];
    usedCount = 0;
    CouponRedemption.find = () => ({ select: () => ({ lean: async () => redemptions.filter((r) => r.live) }) });
    CouponRedemption.create = async (doc) => {
      if (redemptions.some((r) => r.live && r.slot === doc.slot)) throw Object.assign(new Error('dup'), { code: 11000 });
      const r = { _id: id(), ...doc };
      redemptions.push(r);
      return r;
    };
    CouponRedemption.deleteOne = async ({ _id }) => { redemptions = redemptions.filter((r) => String(r._id) !== String(_id)); };
    CouponRedemption.findOneAndUpdate = async ({ order }) => {
      const r = redemptions.find((x) => String(x.order) === String(order) && x.status === 'held');
      if (r) Object.assign(r, { status: 'released', live: false });
      return r || null;
    };
    Coupon.updateOne = async (_filter, update) => {
      const step = update.$inc.usedCount;
      if (step > 0 && usedCount >= coupon.usageLimit) return { modifiedCount: 0 };
      if (step < 0 && usedCount <= 0) return { modifiedCount: 0 };
      usedCount += step;
      return { modifiedCount: 1 };
    };
  });

  const refused = (message) => (err) => err instanceof ApiError && err.status === 400 && message.test(err.message);

  test('each use takes the next free slot, up to the per-customer limit', async () => {
    await holdCoupon(coupon, USER, id());
    await holdCoupon(coupon, USER, id());
    assert.deepEqual(redemptions.map((r) => r.slot), [1, 2]);
    await assert.rejects(holdCoupon(coupon, USER, id()), refused(/already used/));
    assert.equal(usedCount, 2);
  });

  test('two checkouts racing for the same slot: only one gets it', async () => {
    coupon.perUserLimit = 1;
    const results = await Promise.allSettled([holdCoupon(coupon, USER, id()), holdCoupon(coupon, USER, id())]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(usedCount, 1);
  });

  test('when the overall limit is reached the customer\'s slot is given back', async () => {
    usedCount = 3;
    await assert.rejects(holdCoupon(coupon, USER, id()), refused(/usage limit/));
    assert.equal(redemptions.length, 0);
  });

  test('cancelling an unpaid order gives the use back, once', async () => {
    const order = id();
    await holdCoupon(coupon, USER, order);
    await releaseCoupon(order);
    await releaseCoupon(order);
    assert.equal(usedCount, 0);
    await holdCoupon(coupon, USER, id());
    assert.equal(redemptions.filter((r) => r.live).length, 1);
  });
});

describe('Stripe webhooks', () => {
  let events;

  beforeEach(() => {
    finalized.length = 0;
    finalizeFails = false;
    events = new Map();
    WebhookEvent.create = async (doc) => {
      if (events.has(doc.eventId)) throw Object.assign(new Error('dup'), { code: 11000 });
      const record = { _id: id(), ...doc };
      events.set(doc.eventId, record);
      return record;
    };
    WebhookEvent.findOne = async ({ eventId }) => events.get(eventId) || null;
    WebhookEvent.updateOne = async ({ _id }, update) => {
      const record = [...events.values()].find((e) => String(e._id) === String(_id));
      Object.assign(record, update.$set);
      if (update.$unset) delete record.error;
    };
  });

  const ORDER = id();
  const succeeded = (eventId = 'evt_1') => ({ id: eventId, type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', metadata: { orderId: String(ORDER) } } } });

  test('a successful payment finalizes the order found through our Payment record', async () => {
    const ours = id();
    Payment.findOne = () => ({ select: () => ({ lean: async () => ({ order: ours }) }) });
    const result = await handleStripeEvent(succeeded());
    assert.deepEqual(result, { handled: true });
    assert.deepEqual(finalized, [{ orderId: String(ours), intentId: 'pi_1' }]);
  });

  test('without a Payment record the intent metadata is used', async () => {
    Payment.findOne = () => ({ select: () => ({ lean: async () => null }) });
    await handleStripeEvent(succeeded());
    assert.equal(finalized[0].orderId, String(ORDER));
  });

  test('a redelivered event is processed only once', async () => {
    Payment.findOne = () => ({ select: () => ({ lean: async () => null }) });
    await handleStripeEvent(succeeded());
    assert.deepEqual(await handleStripeEvent(succeeded()), { duplicate: true });
    assert.equal(finalized.length, 1);
  });

  test('a failed delivery is recorded, rethrown for Stripe to retry, and processed on the retry', async () => {
    Payment.findOne = () => ({ select: () => ({ lean: async () => null }) });
    finalizeFails = true;
    await assert.rejects(handleStripeEvent(succeeded()), /database timeout/);
    assert.equal(events.get('evt_1').error, 'database timeout');
    assert.equal(events.get('evt_1').processedAt, undefined);

    finalizeFails = false;
    assert.deepEqual(await handleStripeEvent(succeeded()), { handled: true });
    assert.equal(finalized.length, 1);
    assert.ok(events.get('evt_1').processedAt);
    assert.equal(events.get('evt_1').error, undefined);
  });

  test('unknown event types are acknowledged without doing anything', async () => {
    const result = await handleStripeEvent({ id: 'evt_x', type: 'customer.created', data: { object: {} } });
    assert.deepEqual(result, { handled: false });
    assert.equal(finalized.length, 0);
  });
});
