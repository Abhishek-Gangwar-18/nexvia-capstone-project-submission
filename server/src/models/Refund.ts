import mongoose from 'mongoose';

export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'];
export const REFUND_REASONS = ['cancellation', 'return', 'unfulfillable'];

/**
 * One refund of (part of) a payment. The document is created before the gateway is called, and its id
 * is sent to Stripe (metadata + idempotency key), so a retry can always find an earlier attempt instead
 * of refunding twice. Package refund summaries on the order are derived from these documents.
 */
const refundSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    /** The package (Order.packages._id) this refund belongs to. */
    package: { type: mongoose.Schema.Types.ObjectId, required: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    provider: { type: String, enum: ['stripe', 'mock'], required: true },
    providerRefundId: String,
    amount: { type: Number, required: true, min: 0.01 },
    currency: { type: String, required: true, lowercase: true },
    status: { type: String, enum: REFUND_STATUSES, default: 'pending' },
    reason: { type: String, enum: REFUND_REASONS, required: true },
    returnRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'Return' },
    initiatedBy: {
      by: { type: String, enum: ['customer', 'vendor', 'admin', 'system'], required: true },
      actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    attempts: { type: Number, default: 0 },
    lastError: String,
    /** Last status Stripe reported (refund.status), for support. */
    providerStatus: String,
  },
  { timestamps: true },
);

refundSchema.index({ providerRefundId: 1 }, { unique: true, partialFilterExpression: { providerRefundId: { $type: 'string' } } });
refundSchema.index({ order: 1, package: 1 });
// Admin "failed refunds" list and reconciliation of pending ones.
refundSchema.index({ status: 1, updatedAt: -1 });

export const Refund = mongoose.model('Refund', refundSchema);
