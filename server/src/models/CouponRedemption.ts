import mongoose from 'mongoose';

/**
 * One use of a coupon by a customer. `held` while the order is unpaid, `used` once paid (kept even if the
 * order is later cancelled or refunded), `released` when an unpaid order is cancelled or expires.
 *
 * `slot` (1..perUserLimit) is what makes the per-user limit atomic: the unique index on
 * { coupon, user, slot } for live redemptions means two concurrent checkouts can't take the same slot.
 */
const redemptionSchema = new mongoose.Schema(
  {
    coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    slot: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['held', 'used', 'released'], required: true },
    /** true while held or used; released redemptions free their slot. */
    live: { type: Boolean, required: true },
  },
  { timestamps: true },
);

redemptionSchema.index({ coupon: 1, user: 1, slot: 1 }, { unique: true, partialFilterExpression: { live: true } });
redemptionSchema.index({ order: 1 });

export const CouponRedemption = mongoose.model('CouponRedemption', redemptionSchema);
