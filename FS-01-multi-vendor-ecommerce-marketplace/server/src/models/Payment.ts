import mongoose from 'mongoose';

export const PAYMENT_STATUSES = ['created', 'processing', 'succeeded', 'failed', 'canceled'];

/**
 * One payment attempt for an order (a Stripe PaymentIntent, or a test-gateway attempt). The order keeps
 * only a summary; every status change of the attempt is kept in `events`.
 */
const paymentSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, enum: ['stripe', 'mock'], required: true },
    /** Stripe PaymentIntent id (pi_...) or the test gateway's id. */
    intentId: { type: String, required: true },
    /** Stripe charge (ch_...) behind a succeeded intent; vendor transfers are funded from it. */
    chargeId: String,
    amount: { type: Number, required: true },
    currency: { type: String, required: true, lowercase: true },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'created' },
    method: String,
    failureReason: String,
    succeededAt: Date,
    events: [{ type: { type: String }, status: String, detail: String, at: { type: Date, default: Date.now }, _id: false }],
  },
  { timestamps: true },
);

paymentSchema.index({ intentId: 1 }, { unique: true });
paymentSchema.index({ order: 1, createdAt: -1 });
// Reconciliation: attempts that never reached a final state.
paymentSchema.index({ status: 1, updatedAt: 1 });

export const Payment = mongoose.model('Payment', paymentSchema);
