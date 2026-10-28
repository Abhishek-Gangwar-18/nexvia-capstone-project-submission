import mongoose from 'mongoose';

/** Lifecycle of a vendor package inside an order. `pending` means the order is awaiting payment. */
export const PACKAGE_STATUSES = ['pending', 'placed', 'packed', 'shipped', 'delivered', 'cancelled'];

/** Allowed status moves a vendor (or admin) can make on a package. */
export const PACKAGE_TRANSITIONS = {
  placed: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
  pending: [],
};

const itemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    title: { type: String, required: true },
    slug: String,
    image: String,
    category: String,
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
  /**
   * Vendor payout. `route` = Razorpay Route transfer created with the order (held until delivery),
   * `manual` = settled by the platform outside the gateway (no linked account / mock gateway).
   */
  payout: {
    mode: { type: String, enum: ['route', 'manual'], default: 'manual' },
    transferId: String,
    status: { type: String, enum: ['pending', 'on_hold', 'released', 'reversed'], default: 'pending' },
    releasedAt: Date,
  },
  refund: {
    id: String,
    amount: Number,
    status: String,
  },
});

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    packages: [packageSchema],
    shippingAddress: {
      fullName: String,
      phone: String,
      line1: String,
      line2: String,
      city: String,
      state: String,
      pincode: String,
      country: { type: String, default: 'India' },
    },
    pricing: {
      subtotal: { type: Number, required: true },
      discount: { type: Number, default: 0 },
      shipping: { type: Number, default: 0 },
      total: { type: Number, required: true },
    },
    coupon: {
      code: String,
      discount: Number,
      vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    },
    payment: {
      provider: { type: String, enum: ['razorpay', 'mock'], required: true },
      status: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
      gatewayOrderId: String,
      paymentId: String,
      signature: String,
      method: String,
      paidAt: Date,
      splitApplied: { type: Boolean, default: false },
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
orderSchema.index({ 'payment.gatewayOrderId': 1 });

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
