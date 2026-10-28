import mongoose from 'mongoose';

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, trim: true, default: '' },
    type: { type: String, enum: ['percent', 'flat'], required: true },
    value: { type: Number, required: true, min: 1 },
    minOrder: { type: Number, default: 0, min: 0 },
    /** Cap for percentage coupons (0 = no cap). */
    maxDiscount: { type: Number, default: 0, min: 0 },
    expiresAt: Date,
    /** Total redemptions allowed (0 = unlimited). */
    usageLimit: { type: Number, default: 0, min: 0 },
    usedCount: { type: Number, default: 0 },
    perUserLimit: { type: Number, default: 1, min: 1 },
    usedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    /** null -> platform-wide coupon (admin); otherwise only applies to that vendor's items. */
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null, index: true },
    isActive: { type: Boolean, default: true },
    /** Admin-controlled: false hides the code from shopper-facing lists; it still works when typed in. */
    isPublic: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Coupon = mongoose.model('Coupon', couponSchema);
