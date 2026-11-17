import mongoose from 'mongoose';

export const MAX_PERCENT = 90;
/** Fields that define what a coupon gives; they can't change once anyone has redeemed it. */
export const LOCKED_AFTER_USE = ['code', 'type', 'value'];

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, match: [/^[A-Z0-9_-]{3,20}$/, 'Use 3–20 letters, numbers, - or _'] },
    description: { type: String, trim: true, default: '', maxlength: 160 },
    type: { type: String, enum: ['percent', 'flat'], required: true },
    value: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator(v) { return this.type !== 'percent' || v <= MAX_PERCENT; }, message: `A percentage discount cannot exceed ${MAX_PERCENT}%` },
    },
    minOrder: { type: Number, default: 0, min: 0 },
    /** Cap for percentage coupons; null = no cap. */
    maxDiscount: {
      type: Number,
      default: null,
      min: 1,
      validate: { validator(v) { return v == null || this.type === 'percent'; }, message: 'Only percentage coupons have a maximum discount' },
    },
    startsAt: { type: Date, default: null },
    expiresAt: {
      type: Date,
      default: null,
      validate: { validator(v) { return !v || !this.startsAt || v > this.startsAt; }, message: 'The coupon must end after it starts' },
    },
    /** Total redemptions allowed; null = unlimited. Counts held (unpaid checkout) and used redemptions. */
    usageLimit: { type: Number, default: null, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },
    perUserLimit: { type: Number, default: 1, min: 1 },
    /** null -> platform-wide coupon (admin); otherwise only applies to that vendor's items. */
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null, index: true },
    isActive: { type: Boolean, default: true },
    /** Admin-controlled: false hides the code from shopper-facing lists; it still works when typed in. */
    isPublic: { type: Boolean, default: true },
  },
  { timestamps: true },
);

couponSchema.pre('validate', function checkRules() {
  // A flat discount larger than the minimum order would make small orders free.
  if (this.type === 'flat' && this.minOrder > 0 && this.value > this.minOrder) {
    this.invalidate('value', 'A flat discount cannot be more than the minimum order');
  }
  if (!this.isNew && this.usedCount > 0) {
    LOCKED_AFTER_USE.filter((f) => this.isModified(f)).forEach((f) => this.invalidate(f, `${f} can't be changed after the coupon has been used`));
  }
});

export const Coupon = mongoose.model('Coupon', couponSchema);
