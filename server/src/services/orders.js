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

/** Database part of a stock change (direction 1 = sold, -1 = restocked). */
async function writeStock(items, direction, session) {
  for (const item of items) {
    const qty = item.quantity * direction;
    // Pipeline update keeps stock from going negative even under concurrent checkouts.
    await Product.updateOne(
      { _id: item.product },
      [{ $set: { stock: { $max: [0, { $subtract: ['$stock', qty] }] }, sold: { $max: [0, { $add: ['$sold', qty] }] } } }],
      { session },
    );
  }
}

/** Cache + search side effects of a stock change; run only after the database write is committed. */
async function afterStockChange(items) {
  await invalidateProducts(items.map((i) => ({ _id: i.product, slug: i.slug })));
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

  const order = await withTransaction(async (session) => {
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

    for (const pkg of claimed.packages) {
      pkg.status = 'placed';
      pkg.timeline.push({ status: 'placed', note: STATUS_NOTES.placed, at: now });
      pkg.payout.status = 'on_hold';
      const transferId = transferIds.get(String(pkg.vendor));
      if (transferId) pkg.payout.transferId = transferId;
    }
    claimed.recomputeStatus();
    await claimed.save({ session });

    await writeStock(claimed.packages.flatMap((p) => p.items), 1, session);
    if (claimed.coupon?.code) {
      await Coupon.updateOne({ code: claimed.coupon.code }, { $inc: { usedCount: 1 }, $push: { usedBy: claimed.customer } }, { session });
    }
    await clearCartItems(claimed.customer, session);
    return claimed;
  });
  if (!order) return Order.findById(orderId);

  await invalidateCartCache(order.customer);
  await afterStockChange(order.packages.flatMap((p) => p.items));
  return order;
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
