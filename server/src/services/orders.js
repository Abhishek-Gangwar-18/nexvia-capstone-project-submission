import crypto from 'node:crypto';
import { Order, PACKAGE_TRANSITIONS } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { Coupon } from '../models/Coupon.js';
import { Vendor } from '../models/Vendor.js';
import { clearCartItems, invalidateCartCache } from './cart.js';
import { withTransaction } from '../config/db.js';
import { indexProducts } from './search.js';
import { invalidateProducts } from './catalog.js';
import { fetchPaymentMethod, fetchTransfers, refundPayment, releaseTransfer, reverseTransfer } from './payment.js';
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

/**
 * Database part of a stock change (direction 1 = sold, -1 = restocked).
 * A sale only matches while stock >= quantity, so two buyers can never both take the last unit.
 * If any line falls short, the lines already taken are put back (or rolled back by the transaction)
 * and OutOfStockError is thrown.
 */
async function writeStock(items, direction, session) {
  if (direction < 0) {
    for (const item of items) {
      await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity, sold: -item.quantity } }, { session });
    }
    return;
  }
  const taken = [];
  for (const item of items) {
    const { modifiedCount } = await Product.updateOne(
      { _id: item.product, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity, sold: item.quantity } },
      { session },
    );
    if (!modifiedCount) {
      if (!session) await writeStock(taken, -1);
      throw new OutOfStockError(item);
    }
    taken.push(item);
  }
}

/** Cache + search side effects of a stock change; run only after the database write is committed. */
async function afterStockChange(items) {
  await invalidateProducts(items.map((i) => ({ _id: i.product })));
  indexProducts(items.map((i) => i.product));
}

async function adjustStock(items, direction) {
  await writeStock(items, direction);
  await afterStockChange(items);
}

/** Razorpay Route transfer id per vendor package (looked up before the DB transaction - no network calls inside it). */
async function transferIdsByVendor(order, paymentId) {
  if (!order.payment.splitApplied) return new Map();
  const transfers = await fetchTransfers(paymentId);
  const vendors = await Vendor.find({ _id: { $in: order.packages.map((p) => p.vendor) } }).select('razorpayAccountId').lean();
  return new Map(vendors.map((v) => [String(v._id), transfers.get(v.razorpayAccountId)?.id]).filter(([, id]) => id));
}

/**
 * Marks an order as paid exactly once (shared by the checkout callback and the Razorpay webhook).
 * On a replica set (MongoDB Atlas) the order update, stock decrement, coupon redemption and cart clearing
 * commit together in one transaction; the conditional update makes concurrent calls idempotent.
 */
export async function finalizePayment(orderId, { paymentId, signature }) {
  const pending = await Order.findById(orderId).select('payment packages.vendor').lean();
  if (!pending) return null;
  if (pending.payment.status === 'paid') return Order.findById(orderId);

  const method = await fetchPaymentMethod(paymentId);
  const transferIds = await transferIdsByVendor(pending, paymentId);

  let order;
  try {
    order = await withTransaction((session) => claimPaidOrder(orderId, { paymentId, signature, method, transferIds }, session));
  } catch (err) {
    if (!(err instanceof OutOfStockError)) throw err;
    return refundOutOfStock(orderId, { paymentId, signature, method }, err);
  }
  if (!order) return Order.findById(orderId);

  await invalidateCartCache(order.customer);
  await afterStockChange(order.packages.flatMap((p) => p.items));
  return order;
}

/**
 * Stock ran out between checkout and payment (someone else bought the last unit).
 * The customer has already paid, so the order is cancelled and the full amount refunded.
 */
async function refundOutOfStock(orderId, { paymentId, signature, method }, err) {
  const order = await Order.findById(orderId);
  // Without a transaction the claim above may already have marked it paid; packages never left 'pending'.
  if (!order || order.status === 'cancelled' || order.packages.some((p) => p.status !== 'pending')) return order;
  const now = new Date();
  const note = `Cancelled: ${err.message}. Full refund issued.`;
  let refund = null;
  try {
    refund = await refundPayment(paymentId, order.pricing.total);
  } catch (refundErr) {
    logger.error(`Out-of-stock refund for ${order.orderNumber} failed: ${refundErr?.error?.description || refundErr.message}`);
  }
  Object.assign(order.payment, { paymentId, signature, method, paidAt: now, status: refund ? 'refunded' : 'paid' });
  order.packages.forEach((pkg) => {
    pkg.status = 'cancelled';
    pkg.timeline.push({ status: 'cancelled', note, at: now });
    pkg.payout.status = 'reversed';
    pkg.refund = { id: refund?.id, amount: pkg.total, status: refund ? refund.status || 'processed' : 'failed' };
  });
  order.status = 'cancelled';
  await order.save();
  logger.warn(`Order ${order.orderNumber} cancelled after payment: ${err.message}`);
  return order;
}

/** Claims a pending order as paid and takes the stock (inside the transaction when available). */
async function claimPaidOrder(orderId, { paymentId, signature, method, transferIds }, session) {
  const now = new Date();
  const claimed = await Order.findOneAndUpdate(
    { _id: orderId, 'payment.status': { $in: ['pending', 'failed'] } },
    {
      $set: {
        'payment.status': 'paid',
        'payment.paymentId': paymentId,
        'payment.signature': signature,
        'payment.method': method,
        'payment.paidAt': now,
        placedAt: now,
      },
    },
    { new: true, session },
  );
  if (!claimed) return null; // already finalized by the other path

  // Stock first: if it falls short, nothing below runs and the order is refunded instead.
  await writeStock(claimed.packages.flatMap((p) => p.items), 1, session);

  for (const pkg of claimed.packages) {
    pkg.status = 'placed';
    pkg.timeline.push({ status: 'placed', note: STATUS_NOTES.placed, at: now });
    pkg.payout.status = 'on_hold';
    const transferId = transferIds.get(String(pkg.vendor));
    if (transferId) pkg.payout.transferId = transferId;
  }
  claimed.recomputeStatus();
  await claimed.save({ session });

  if (claimed.coupon?.code) {
    await Coupon.updateOne({ code: claimed.coupon.code }, { $inc: { usedCount: 1 }, $push: { usedBy: claimed.customer } }, { session });
  }
  await clearCartItems(claimed.customer, session);
  return claimed;
}

/**
 * Moves one package along its lifecycle (placed -> packed -> shipped -> delivered, or -> cancelled)
 * and runs the side effects: payout release on delivery; restock, transfer reversal and refund on cancel.
 */
export async function transitionPackage(order, pkg, next, { note, trackingId } = {}) {
  const allowed = PACKAGE_TRANSITIONS[pkg.status] || [];
  if (!allowed.includes(next)) {
    throw new ApiError(400, `A ${pkg.status} package cannot be moved to ${next}`);
  }
  const now = new Date();
  pkg.status = next;
  pkg.timeline.push({ status: next, note: note || STATUS_NOTES[next], at: now });
  if (trackingId) pkg.trackingId = trackingId;
  if (next === 'shipped' && !pkg.trackingId) pkg.trackingId = `VDX${crypto.randomInt(100000000, 999999999)}`;

  if (next === 'delivered') {
    const released = pkg.payout.mode === 'route' ? await releaseTransfer(pkg.payout.transferId) : true;
    if (released) {
      pkg.payout.status = 'released';
      pkg.payout.releasedAt = now;
    }
  }

  if (next === 'cancelled') {
    await adjustStock(pkg.items, -1);
    if (pkg.payout.mode === 'route' && pkg.payout.transferId) await reverseTransfer(pkg.payout.transferId, pkg.vendorEarning);
    pkg.payout.status = 'reversed';

    if (order.payment.status === 'paid' && order.payment.paymentId) {
      const othersLive = order.packages.some((p) => p !== pkg && p.status !== 'cancelled');
      const amount = round2(pkg.total + (othersLive ? 0 : order.pricing.shipping));
      try {
        const refund = amount > 0 ? await refundPayment(order.payment.paymentId, amount) : null;
        pkg.refund = { id: refund?.id, amount, status: refund?.status || 'processed' };
      } catch (err) {
        logger.warn(`Refund for ${order.orderNumber} failed: ${err?.error?.description || err.message}`);
        pkg.refund = { amount, status: 'failed' };
      }
      if (!othersLive) order.payment.status = 'refunded';
    }
  }

  if (order.payment.status === 'refunded') order.status = 'cancelled';
  else order.recomputeStatus();
  return order;
}
