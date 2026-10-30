import mongoose from 'mongoose';
import { addressSchema } from './Address.js';

/** Lifecycle of a vendor package inside an order. `pending` means the order is awaiting payment. */
export const PACKAGE_STATUSES = ['pending', 'placed', 'packed', 'shipped', 'delivered', 'cancelled'];

export const PAYOUT_STATUSES = ['pending', 'on_hold', 'releasing', 'released', 'reversed', 'reversal_failed'];

/** Allowed status moves a vendor (or admin) can make on a package. */
export const PACKAGE_TRANSITIONS = {
  placed: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
  pending: [],
};

/** Why a package was cancelled. `other` needs a note. */
export const CANCEL_REASONS = ['changed_mind', 'out_of_stock', 'payment_timeout', 'payment_after_cancel', 'vendor_unable', 'fraud', 'other'];
export const CANCEL_ACTORS = ['customer', 'vendor', 'admin', 'system'];
/** Reason codes each actor may pick (system codes are set by the server only). */
export const CANCEL_REASONS_BY_ACTOR = {
  customer: ['changed_mind', 'other'],
  vendor: ['out_of_stock', 'vendor_unable', 'other'],
  admin: ['out_of_stock', 'vendor_unable', 'fraud', 'other'],
  system: ['payment_timeout', 'payment_after_cancel', 'out_of_stock', 'changed_mind'],
};

const itemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    title: { type: String, required: true },
    image: String,
    /** Category id at purchase time (snapshot; the category may be renamed or deleted later). */
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    total: { type: Number, required: true },
  },
  { _id: false },
);

const packageSchema = new mongoose.Schema({
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
  storeName: String,
  items: [itemSchema],
  subtotal: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  total: { type: Number, required: true },
  commissionRate: { type: Number, required: true },
  commission: { type: Number, required: true },
  vendorEarning: { type: Number, required: true },
  status: { type: String, enum: PACKAGE_STATUSES, default: 'pending' },
  timeline: [{ status: String, note: String, at: { type: Date, default: Date.now }, _id: false }],
  trackingId: String,
  /** Who cancelled this package and why (set once, when it moves to cancelled). */
  cancellation: {
    by: { type: String, enum: CANCEL_ACTORS },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reasonCode: { type: String, enum: CANCEL_REASONS },
    note: String,
    at: Date,
  },
  /**
   * Vendor payout (separate charges and transfers): the platform collects the payment, and the vendor
   * share is transferred only once the return window after delivery has passed with no open return.
   * pending (unpaid) -> on_hold (paid) -> releasing -> released; reversed when the package is cancelled.
   * `stripe` = Stripe Connect transfer to the vendor account, `manual` = settled by the platform outside Stripe.
   */
  payout: {
    mode: { type: String, enum: ['stripe', 'manual'], default: 'manual' },
    status: { type: String, enum: PAYOUT_STATUSES, default: 'pending' },
    /** Earliest release: delivered + RETURN_WINDOW_DAYS. */
    releaseAfter: Date,
    transferId: String,
    /** What was actually paid out: vendorEarning minus the vendor share of refunded returns. */
    amount: Number,
    releasedAt: Date,
    attempts: { type: Number, default: 0 },
    /** When the payout job claimed this payout (a stale "releasing" claim is reset by reconciliation). */
    claimedAt: Date,
    /** Why the last release attempt did not go through (shown to admins, retried by the payout job). */
    error: String,
    reversalError: String,
  },
  /** Summary of this package's refunds (the Refund documents are the source of truth). */
  refund: {
    id: String,
    amount: Number,
    /** succeeded | pending | failed (failed needs follow-up: admins can retry it). */
    status: String,
    error: String,
    at: Date,
  },
  /** Returned and refunded items so far: units, what the customer got back and the vendor share of it. */
  returned: {
    quantity: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    vendorShare: { type: Number, default: 0 },
  },
});

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    packages: [packageSchema],
    /** Copied at checkout and never linked to the customer's saved addresses. */
    shippingAddress: {
      type: addressSchema(
        { fullName: { type: String, required: true, trim: true }, phone: { type: String, required: true, trim: true } },
        { _id: false },
      ),
      required: true,
    },
    /**
     * Stock held at checkout. held -> committed when paid, held -> released when the order is cancelled
     * or the payment window (expiresAt) passes. Orders from before reservations have no reservation.
     */
    reservation: {
      status: { type: String, enum: ['held', 'committed', 'released'] },
      expiresAt: Date,
    },
    pricing: {
      subtotal: { type: Number, required: true },
      discount: { type: Number, default: 0 },
      shipping: { type: Number, default: 0 },
      total: { type: Number, required: true },
    },
    coupon: {
      /** The redeemed coupon; `code` is a display snapshot. */
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon' },
      code: String,
      discount: Number,
      vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    },
    /** Summary of the payment; each attempt is a Payment document. */
    payment: {
      provider: { type: String, enum: ['stripe', 'mock'], required: true },
      status: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
      /** The current attempt: Stripe PaymentIntent id (or the test gateway id). */
      intentId: String,
      /** Provider reference of the succeeded payment (the PaymentIntent id for Stripe). */
      paymentId: String,
      method: String,
      currency: { type: String, lowercase: true, default: 'inr' },
      paidAt: Date,
    },
    status: {
      type: String,
      enum: ['pending_payment', 'placed', 'processing', 'shipped', 'delivered', 'cancelled', 'payment_failed'],
      default: 'pending_payment',
      index: true,
    },
    placedAt: Date,
  },
  { timestamps: true },
);

orderSchema.index({ 'packages.vendor': 1, createdAt: -1 });
orderSchema.index({ 'payment.intentId': 1 });
// Payout job: delivered packages whose return window has passed.
orderSchema.index({ 'packages.payout.status': 1, 'packages.payout.releaseAfter': 1 });
// Expiry sweep: { 'reservation.status': 'held', 'reservation.expiresAt': { $lt: now } } (services/orders.js).
orderSchema.index({ 'reservation.status': 1, 'reservation.expiresAt': 1 });

/** Derives the overall order status from payment + package states. */
orderSchema.methods.recomputeStatus = function recomputeStatus() {
  if (this.payment.status === 'failed') return (this.status = 'payment_failed');
  if (this.payment.status === 'pending') return (this.status = 'pending_payment');
  const live = this.packages.filter((p) => p.status !== 'cancelled');
  if (!live.length) return (this.status = 'cancelled');
  if (live.every((p) => p.status === 'delivered')) return (this.status = 'delivered');
  if (live.some((p) => ['shipped', 'delivered'].includes(p.status))) return (this.status = 'shipped');
  if (live.some((p) => p.status === 'packed')) return (this.status = 'processing');
  return (this.status = 'placed');
};

export const Order = mongoose.model('Order', orderSchema);
