import crypto from 'node:crypto';
import { Order, PACKAGE_TRANSITIONS } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { commitCoupon, releaseCoupon } from './coupons.js';
import { Payment } from '../models/Payment.js';
import { cache } from './cache.js';
import { clearCartItems, invalidateCartCache } from './cart.js';
import { withTransaction } from '../config/db.js';
import { indexProducts } from './search.js';
import { invalidateProducts } from './catalog.js';
import { confirmCapture } from './payment.js';
import { issueRefund, settlePaymentStatus } from './refunds.js';
import { reversePayout, scheduleRelease } from './payouts.js';
import { ApiError, round2 } from '../utils/http.js';
import { logger } from '../utils/logger.js';

export const newOrderNumber = () => `VD${Date.now().toString().slice(-8)}${crypto.randomInt(10, 99)}`;

const STATUS_NOTES = {
  placed: 'Payment received, order placed',
  packed: 'Seller has packed your items',
  shipped: 'Package handed over to the courier',
  delivered: 'Package delivered',
  cancelled: 'Package cancelled',
};

export class OutOfStockError extends ApiError {
  constructor(item) {
    super(409, `"${item.title}" no longer has enough stock`);
    this.item = item;
  }
}

/** How long checkout holds stock for an unpaid order. */
export const RESERVATION_MINUTES = Number(process.env.STOCK_RESERVATION_MINUTES) || 15;

const lineItems = (order) => order.packages.flatMap((p) => p.items);

/**
 * Takes stock for an unpaid order. Each line only matches while stock >= quantity, so two buyers can
 * never hold the last unit; if a line falls short, the lines already taken are put back.
 */
export async function reserveStock(items, session) {
  const taken = [];
  for (const item of items) {
    const { modifiedCount } = await Product.updateOne(
      { _id: item.product, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } },
      { session },
    );
    if (!modifiedCount) {
      if (!session) await releaseStock(taken);
      throw new OutOfStockError(item);
    }
    taken.push(item);
  }
}

/** Returns held stock (unpaid order cancelled or expired). */
export async function releaseStock(items, session) {
  for (const item of items) {
    await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }, { session });
  }
}

/** Turns a held reservation into a sale. */
async function commitSale(items, session) {
  for (const item of items) {
    await Product.updateOne({ _id: item.product }, { $inc: { sold: item.quantity } }, { session });
  }
}

/** Puts sold stock back (a paid package was cancelled). */
async function restockSold(items, session) {
  for (const item of items) {
    await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity, sold: -item.quantity } }, { session });
  }
}

/** Cache + search side effects of a stock change; run only after the database write is committed. */
export async function afterStockChange(items) {
  await invalidateProducts(items.map((i) => ({ _id: i.product })));
  indexProducts(items.map((i) => i.product));
}

/**
 * Cancels an unpaid order and releases its held stock, exactly once. The filter only matches while the
 * order is unpaid and not cancelled, so it can never race a payment being finalized: the payment claim
 * excludes cancelled orders, and both are single-document atomic updates on the same order.
 */
export async function cancelUnpaidOrder(orderId, { note, cancellation = { by: 'system' }, extraFilter = {} } = {}) {
  const now = new Date();
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: { $ne: 'cancelled' }, 'payment.status': { $in: ['pending', 'failed'] }, ...extraFilter },
    {
      $set: {
        status: 'cancelled',
        'payment.status': 'failed',
        'packages.$[].status': 'cancelled',
        'packages.$[].cancellation': { ...cancellation, note: cancellation.note ?? note, at: now },
      },
      $push: { 'packages.$[].timeline': { status: 'cancelled', note, at: now } },
    },
    { new: true },
  );
  if (!order) return null;
  await releaseCoupon(order._id);
  if (order.reservation?.status === 'held') {
    await releaseStock(lineItems(order));
    await Order.updateOne({ _id: order._id }, { $set: { 'reservation.status': 'released' } });
    await afterStockChange(lineItems(order));
  }
  return order;
}

/** Cancels unpaid orders whose reservation window has passed (runs every minute from index.js). */
export async function releaseExpiredReservations() {
  const expiredFilter = () => ({ 'reservation.status': 'held', 'reservation.expiresAt': { $lt: new Date() } });
  // Served by the { 'reservation.status': 1, 'reservation.expiresAt': 1 } index on Order.
  const expired = await Order.find(expiredFilter()).select('_id').limit(100).lean();
  let released = 0;
  for (const { _id } of expired) {
    const order = await cancelUnpaidOrder(_id, {
      note: `Payment not received within ${RESERVATION_MINUTES} minutes`,
      cancellation: { by: 'system', reasonCode: 'payment_timeout' },
      extraFilter: expiredFilter(),
    });
    if (order) released++;
  }
  if (released) logger.info(`Reservations: released stock for ${released} unpaid order(s)`);
  return released;
}

/** Records a status change of a payment attempt (checkout callback, webhook, reconciliation). */
export async function recordPaymentEvent(intentId, { status, type, detail, ...fields }) {
  return Payment.findOneAndUpdate(
    { intentId },
    { $set: { ...(status ? { status } : {}), ...fields }, $push: { events: { type, status, detail, at: new Date() } } },
    { new: true },
  );
}

/** A failed attempt: the order stays payable (the customer can retry with the same payment). */
export async function recordPaymentFailure(intentId, reason) {
  const payment = await recordPaymentEvent(intentId, { status: 'failed', type: 'failed', detail: reason, failureReason: reason });
  if (payment) {
    const order = await Order.findOne({ _id: payment.order, 'payment.status': 'pending' });
    if (order) {
      order.payment.status = 'failed';
      order.recomputeStatus();
      await order.save();
    }
  }
  return payment;
}

/**
 * Marks an order as paid exactly once (shared by the checkout callback, the Stripe webhook and
 * reconciliation). The payment is verified with Stripe first (succeeded, this order, exact amount).
 * On a replica set (MongoDB Atlas) the order update, sale commit, coupon redemption and cart clearing
 * commit together in one transaction; the conditional update makes concurrent calls idempotent.
 * A payment that lands on an order already cancelled (e.g. expired reservation) is refunded.
 */
export async function finalizePayment(orderId, { intentId }) {
  const pending = await Order.findById(orderId).select('payment pricing.total').lean();
  if (!pending) return null;
  if (pending.payment.status === 'paid') return Order.findById(orderId);

  // Succeeded, for this order and the exact amount - otherwise nothing is marked paid.
  const { method, chargeId } = await confirmCapture(intentId, { provider: pending.payment.provider, orderId, amount: pending.pricing.total });
  await recordPaymentEvent(intentId, { status: 'succeeded', type: 'succeeded', method, chargeId, succeededAt: new Date() });
  const payment = { intentId, method };

  let order;
  try {
    order = await withTransaction((session) => claimPaidOrder(orderId, payment, session));
  } catch (err) {
    if (!(err instanceof OutOfStockError)) throw err;
    return refundUnfulfillable(orderId, payment, err.message, 'out_of_stock');
  }
  if (!order) {
    const current = await Order.findById(orderId);
    if (current?.status === 'cancelled' && !['paid', 'refunded'].includes(current.payment.status)) {
      return refundUnfulfillable(orderId, payment, 'payment arrived after the order was cancelled', 'payment_after_cancel');
    }
    return current;
  }

  await invalidateCartCache(order.customer);
  await afterStockChange(lineItems(order));
  return order;
}

/**
 * The customer paid but the order can't be fulfilled (stock gone, or the order was already cancelled
 * when the payment landed). The order is cancelled and every package refunded in full (shipping with
 * the last one). Nothing was paid out to vendors yet, so there is nothing to reverse.
 */
async function refundUnfulfillable(orderId, { intentId, method }, reason, reasonCode) {
  const order = await Order.findById(orderId);
  if (!order || order.payment.status === 'refunded') return order;
  // Without a transaction the claim may already have marked it paid; packages never left 'pending' then.
  if (order.packages.some((p) => !['pending', 'cancelled'].includes(p.status))) return order;
  const now = new Date();
  Object.assign(order.payment, { intentId, paymentId: intentId, method, paidAt: now, status: 'paid' });
  const last = order.packages.length - 1;
  for (const [i, pkg] of order.packages.entries()) {
    pkg.status = 'cancelled';
    pkg.cancellation = { by: 'system', reasonCode, note: reason, at: now };
    pkg.payout.status = 'reversed';
    await issueRefund({
      order,
      pkg,
      amount: pkg.total + (i === last ? order.pricing.shipping : 0),
      reason: 'unfulfillable',
      initiatedBy: { by: 'system' },
    });
    const outcome = pkg.refund?.status === 'failed' ? 'Refund failed - needs manual follow-up.' : 'Full refund issued.';
    pkg.timeline.push({ status: 'cancelled', note: `Cancelled: ${reason}. ${outcome}`, at: now });
  }
  settlePaymentStatus(order);
  order.status = 'cancelled';
  await order.save();
  logger.warn(`Order ${order.orderNumber} cancelled after payment: ${reason}`);
  return order;
}

/** Claims an unpaid, uncancelled order as paid and turns its stock reservation into a sale. */
async function claimPaidOrder(orderId, { intentId, method }, session) {
  const now = new Date();
  const claimed = await Order.findOneAndUpdate(
    { _id: orderId, 'payment.status': { $in: ['pending', 'failed'] }, status: { $ne: 'cancelled' } },
    {
      $set: {
        'payment.status': 'paid',
        'payment.intentId': intentId,
        'payment.paymentId': intentId,
        'payment.method': method,
        'payment.paidAt': now,
        placedAt: now,
      },
    },
    { new: true, session },
  );
  if (!claimed) return null; // already finalized by the other path, or cancelled

  // Orders placed before reservations existed hold no stock yet: take it now (may throw OutOfStockError).
  if (claimed.reservation?.status !== 'held') await reserveStock(lineItems(claimed), session);
  await commitSale(lineItems(claimed), session);
  claimed.set('reservation.status', 'committed');

  for (const pkg of claimed.packages) {
    pkg.status = 'placed';
    pkg.timeline.push({ status: 'placed', note: STATUS_NOTES.placed, at: now });
    // The vendor share waits with the platform until delivery + the return window.
    pkg.payout.status = 'on_hold';
  }
  claimed.recomputeStatus();
  await claimed.save({ session });

  if (claimed.coupon?.code) {
    await commitCoupon(claimed, session);
  }
  await clearCartItems(claimed.customer, session);
  return claimed;
}

/**
 * Runs fn while holding a short lock on one package, so two concurrent status updates (double click,
 * vendor and admin at once) can't both pass the transition check and refund or restock twice.
 */
export async function withPackageLock(packageId, fn) {
  const key = `lock:package:${packageId}`;
  if ((await cache.incrWithTtl(key, 30)) > 1) throw new ApiError(409, 'This package is being updated. Please try again.');
  try {
    return await fn();
  } finally {
    await cache.del(key);
  }
}

/**
 * Moves one package along its lifecycle (placed -> packed -> shipped -> delivered, or -> cancelled)
 * and runs the side effects: payout scheduling on delivery; restock, payout reversal and refund on cancel.
 */
export async function transitionPackage(order, pkg, next, { note, trackingId, cancellation } = {}) {
  const allowed = PACKAGE_TRANSITIONS[pkg.status] || [];
  if (!allowed.includes(next)) {
    throw new ApiError(400, `A ${pkg.status} package cannot be moved to ${next}`);
  }
  if (next === 'cancelled' && !cancellation?.by) throw new Error('transitionPackage: cancellation { by, reasonCode } is required');
  const now = new Date();
  pkg.status = next;
  pkg.timeline.push({ status: next, note: note || STATUS_NOTES[next], at: now });
  if (trackingId) pkg.trackingId = trackingId;
  if (next === 'shipped' && !pkg.trackingId) pkg.trackingId = `VDX${crypto.randomInt(100000000, 999999999)}`;

  // Delivered: the vendor is paid by the payout job once the return window has passed.
  if (next === 'delivered') scheduleRelease(pkg, now);

  if (next === 'cancelled') {
    pkg.cancellation = { ...cancellation, at: now };
    await restockSold(pkg.items);
    await afterStockChange(pkg.items);
    if (!(await reversePayout(pkg))) {
      // The vendor still holds this share: recorded and listed for admins instead of pretending it came back.
      pkg.timeline.push({ status: 'cancelled', note: `Payout reversal of ${pkg.vendorEarning} failed - needs manual follow-up`, at: now });
    }

    if (order.payment.status === 'paid' && order.payment.paymentId) {
      const othersLive = order.packages.some((p) => p !== pkg && p.status !== 'cancelled');
      const amount = round2(pkg.total + (othersLive ? 0 : order.pricing.shipping));
      // The Refund document is written before Stripe is called; a failure is recorded, never lost.
      await issueRefund({ order, pkg, amount, reason: 'cancellation', initiatedBy: { by: cancellation.by, actorId: cancellation.actorId } });
      if (pkg.refund?.status === 'failed') {
        pkg.timeline.push({ status: 'cancelled', note: `Refund of ${amount} failed - needs manual follow-up`, at: now });
      }
      settlePaymentStatus(order);
    }
  }

  if (order.payment.status === 'refunded') order.status = 'cancelled';
  else order.recomputeStatus();
  return order;
}
