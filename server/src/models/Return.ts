import mongoose from 'mongoose';

export const RETURN_REASONS = ['damaged', 'wrong_item', 'not_as_described', 'size_fit', 'changed_mind', 'other'];
export const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled'];
/** A return in one of these states blocks the vendor payout for its package. */
export const OPEN_RETURN_STATUSES = ['requested', 'approved', 'received'];

/**
 * A request to return items from a delivered package, within the return window.
 * requested -> approved (vendor) -> received (vendor inspected it) -> refunded; or rejected / cancelled.
 * The admin can act on any step.
 */
const returnSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    package: { type: mongoose.Schema.Types.ObjectId, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    items: {
      type: [
        {
          product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
          title: String,
          quantity: { type: Number, required: true, min: 1 },
          /** What was paid for these units (after their share of the coupon). */
          amount: { type: Number, required: true, min: 0 },
          _id: false,
        },
      ],
      validate: { validator: (v) => v.length > 0, message: 'Choose at least one item to return' },
    },
    /** Refund total: items plus shipping when the whole package (the last live one) comes back. */
    amount: { type: Number, required: true, min: 0 },
    shippingRefund: { type: Number, default: 0 },
    /** The vendor part of the item refund (the rest is the platform commission). */
    vendorShare: { type: Number, required: true, min: 0 },
    reasonCode: { type: String, enum: RETURN_REASONS, required: true },
    note: { type: String, trim: true, maxlength: 500 },
    photos: {
      type: [{ url: { type: String, required: true }, key: String, _id: false }],
      validate: { validator: (v) => v.length <= 5, message: 'Up to 5 photos' },
    },
    status: { type: String, enum: RETURN_STATUSES, default: 'requested' },
    vendorNote: { type: String, trim: true, maxlength: 500 },
    restocked: { type: Boolean, default: false },
    refund: { type: mongoose.Schema.Types.ObjectId, ref: 'Refund' },
    timeline: [
      {
        status: { type: String, enum: RETURN_STATUSES },
        by: { type: String, enum: ['customer', 'vendor', 'admin', 'system'] },
        actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: String,
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
  },
  { timestamps: true },
);

returnSchema.index({ vendor: 1, status: 1, createdAt: -1 });
returnSchema.index({ customer: 1, createdAt: -1 });
returnSchema.index({ order: 1, package: 1 });
returnSchema.index({ status: 1, createdAt: -1 });

export const Return = mongoose.model('Return', returnSchema);
