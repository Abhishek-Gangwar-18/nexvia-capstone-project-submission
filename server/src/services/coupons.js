import { Coupon } from '../models/Coupon.js';
import { CouponRedemption } from '../models/CouponRedemption.js';
import { ApiError } from '../utils/http.js';

/** Live (held or used) redemptions of a coupon by one customer. */
export const liveRedemptions = (couponId, userId) => CouponRedemption.find({ coupon: couponId, user: userId, live: true }).select('slot').lean();

/**
 * Takes one use of the coupon for an unpaid order, atomically on both limits:
 * - per user: claims the lowest free slot; the unique { coupon, user, slot } index rejects a concurrent duplicate;
 * - overall: increments usedCount only while it is below usageLimit.
 * If the overall limit is hit, the slot is given back.
 */
export async function holdCoupon(coupon, userId, orderId) {
  const taken = new Set((await liveRedemptions(coupon._id, userId)).map((r) => r.slot));
  const slot = Array.from({ length: coupon.perUserLimit }, (_, i) => i + 1).find((s) => !taken.has(s));
  if (!slot) throw new ApiError(400, 'You have already used this coupon');

  let redemption;
  try {
    redemption = await CouponRedemption.create({ coupon: coupon._id, user: userId, order: orderId, slot, status: 'held', live: true });
  } catch (err) {
    if (err.code === 11000) throw new ApiError(400, 'You have already used this coupon');
    throw err;
  }
  const { modifiedCount } = await Coupon.updateOne(
    { _id: coupon._id, isActive: true, $or: [{ usageLimit: null }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
    { $inc: { usedCount: 1 } },
  );
  if (!modifiedCount) {
    await CouponRedemption.deleteOne({ _id: redemption._id });
    throw new ApiError(400, 'This coupon has reached its usage limit');
  }
}

/** Gives the use back when an unpaid order is cancelled, expires or fails to open (paid orders keep it). */
export async function releaseCoupon(orderId) {
  const released = await CouponRedemption.findOneAndUpdate({ order: orderId, status: 'held' }, { $set: { status: 'released', live: false } });
  if (released) await Coupon.updateOne({ _id: released.coupon, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
}

/** Payment confirmed: the held use becomes permanent. Orders placed before holds existed are counted now. */
export async function commitCoupon(order, session) {
  if (!order.coupon?.code) return;
  const { matchedCount } = await CouponRedemption.updateOne({ order: order._id, status: 'held' }, { $set: { status: 'used' } }, { session });
  if (matchedCount) return;
  const filter = order.coupon.id ? { _id: order.coupon.id } : { code: order.coupon.code };
  await Coupon.updateOne(filter, { $inc: { usedCount: 1 } }, { session });
}
