import mongoose from 'mongoose';
import { z } from 'zod';
import { Order } from '../models/Order.js';
import { User } from '../models/User.js';
import { Vendor } from '../models/Vendor.js';
import { cache } from '../services/cache.js';
import { addressSchema } from './auth.controller.js';
import { getCart } from '../services/cart.js';
import { applyCommission, distributeDiscount, evaluateCoupon, getSettings, shippingFor } from '../services/pricing.js';
import {
  checkoutConfig,
  createGatewayOrder,
  paymentProvider,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../services/payment.js';
import { finalizePayment, newOrderNumber, transitionPackage } from '../services/orders.js';
import { streamInvoice } from '../services/invoice.js';
import { ApiError, paginated, parsePagination, round2 } from '../utils/http.js';
import { logger } from '../utils/logger.js';

export const checkoutSchema = z
  .object({
    addressId: z.string().optional(),
    address: addressSchema.optional(),
    couponCode: z.string().trim().max(30).optional(),
  })
  .refine((d) => d.addressId || d.address, { message: 'Choose a delivery address', path: ['address'] });

export const verifySchema = z.object({
  razorpay_payment_id: z.string().optional(),
  razorpay_order_id: z.string().optional(),
  razorpay_signature: z.string().optional(),
  /** Only used by the built-in test gateway to simulate success or a declined card. */
  outcome: z.enum(['success', 'failure']).optional(),
});

const prefill = (user) => ({ name: user.name, email: user.email, contact: user.phone || '' });

/**
 * Creates an order from the cart: groups items into one package per vendor, applies the coupon,
 * computes the platform commission and vendor earnings per package, and opens a gateway order whose
 * Razorpay Route transfers send each vendor's share to their linked account.
 */
async function placeOrder(req) {
  const userId = req.user._id;
  const cart = await getCart(userId);
  if (!cart.items.length) throw new ApiError(400, 'Your cart is empty');
  if (cart.items.some((i) => !i.inStock)) throw new ApiError(400, 'Remove out-of-stock items from your cart to continue');

  let shippingAddress = req.body.address;
  if (req.body.addressId) {
    const user = await User.findById(userId);
    const saved = user.addresses.id(req.body.addressId);
    if (!saved) throw new ApiError(404, 'Delivery address not found');
    shippingAddress = saved.toObject();
  }

  const settings = await getSettings();
  const coupon = req.body.couponCode
    ? await evaluateCoupon(
        req.body.couponCode,
        cart.items.map((l) => ({ vendorId: String(l.vendor._id), lineTotal: l.lineTotal })),
        userId,
      )
    : null;

  const vendorIds = [...new Set(cart.items.map((i) => String(i.vendor._id)))];
  const vendors = new Map((await Vendor.find({ _id: { $in: vendorIds } }).lean()).map((v) => [String(v._id), v]));

  const packages = vendorIds.map((vendorId) => {
    const lines = cart.items.filter((i) => String(i.vendor._id) === vendorId);
    return {
      vendor: vendorId,
      storeName: vendors.get(vendorId)?.storeName,
      items: lines.map((l) => ({
        product: l.product._id,
        title: l.product.title,
        image: l.product.thumbnail,
        category: l.product.category,
        price: l.product.price,
        quantity: l.quantity,
        total: l.lineTotal,
      })),
      subtotal: round2(lines.reduce((sum, l) => sum + l.lineTotal, 0)),
      discount: 0,
    };
  });
  if (coupon) distributeDiscount(packages, coupon.discount, coupon.vendorId);
  packages.forEach((pkg) => applyCommission(pkg, vendors.get(pkg.vendor)?.commissionRate ?? settings.commissionRate));

  const subtotal = round2(packages.reduce((sum, p) => sum + p.subtotal, 0));
  const discount = coupon?.discount || 0;
  const shipping = shippingFor(subtotal - discount, settings);
  const total = round2(subtotal - discount + shipping);

  const order = new Order({
    orderNumber: newOrderNumber(),
    customer: userId,
    packages,
    shippingAddress,
    pricing: { subtotal, discount, shipping, total },
    coupon: coupon ? { code: coupon.coupon.code, discount, vendor: coupon.vendorId } : undefined,
    payment: { provider: paymentProvider(), status: 'pending' },
  });

  const transfers = order.packages
    .filter((p) => vendors.get(String(p.vendor))?.razorpayAccountId)
    .map((p) => ({
      account: vendors.get(String(p.vendor)).razorpayAccountId,
      amount: p.vendorEarning,
      notes: { order: order.orderNumber, store: p.storeName },
    }));

  let gateway;
  try {
    gateway = await createGatewayOrder({
      amount: total,
      receipt: order.orderNumber,
      notes: { orderNumber: order.orderNumber, customer: req.user.email },
      transfers,
    });
  } catch (err) {
    throw new ApiError(502, `Could not start payment: ${err.message}`);
  }

  order.payment.gatewayOrderId = gateway.id;
  order.payment.splitApplied = gateway.splitApplied;
  order.packages.forEach((pkg) => {
    const linked = Boolean(vendors.get(String(pkg.vendor))?.razorpayAccountId);
    pkg.payout = { mode: gateway.splitApplied && linked ? 'route' : 'manual', status: 'pending' };
  });
  await order.save();

  return {
    order: { _id: order._id, orderNumber: order.orderNumber, pricing: order.pricing },
    payment: checkoutConfig(order),
    prefill: prefill(req.user),
  };
}

const IDEMPOTENCY_TTL = 24 * 60 * 60;

/**
 * POST /orders/checkout requires an Idempotency-Key header. A retry with the same key (double click,
 * network retry) gets the first response back instead of creating a second order and gateway order.
 */
export async function checkout(req, res) {
  const key = req.get('Idempotency-Key');
  if (!key || !/^[\w-]{8,100}$/.test(key)) {
    throw new ApiError(400, 'Send an Idempotency-Key header (8-100 letters, digits, - or _) with checkout');
  }
  const base = `idem:checkout:${req.user._id}:${key}`;
  const saved = await cache.getJSON(`${base}:result`);
  if (saved) return res.status(201).json(saved);
  if ((await cache.incrWithTtl(`${base}:lock`, 60)) > 1) throw new ApiError(409, 'This checkout is already being processed');
  try {
    const result = await placeOrder(req);
    await cache.setJSON(`${base}:result`, result, IDEMPOTENCY_TTL);
    return res.status(201).json(result);
  } finally {
    // A failed attempt releases the key so the customer can fix the problem and retry with it.
    await cache.del(`${base}:lock`);
  }
}

/** Payment config for an order still awaiting payment (retry from the order page). */
export async function paymentConfig(req, res) {
  const order = await Order.findOne({ _id: req.params.id, customer: req.user._id });
  if (!order) throw new ApiError(404, 'Order not found');
  if (order.payment.status === 'paid') throw new ApiError(400, 'This order is already paid');
  if (order.status === 'cancelled') throw new ApiError(400, 'This order was cancelled');

  if (order.payment.provider !== paymentProvider()) {
    const gateway = await createGatewayOrder({ amount: order.pricing.total, receipt: order.orderNumber, notes: { orderNumber: order.orderNumber } });
    order.payment.provider = gateway.provider;
    order.payment.gatewayOrderId = gateway.id;
    order.payment.splitApplied = false;
    order.packages.forEach((pkg) => {
      pkg.payout.mode = 'manual';
    });
    await order.save();
  }
  res.json({ order: { _id: order._id, orderNumber: order.orderNumber, pricing: order.pricing }, payment: checkoutConfig(order), prefill: prefill(req.user) });
}

export async function verifyPayment(req, res) {
  const order = await Order.findOne({ _id: req.params.id, customer: req.user._id });
  if (!order) throw new ApiError(404, 'Order not found');
  if (order.payment.status === 'paid') return res.json({ order });
  if (order.status === 'cancelled') throw new ApiError(400, 'This order was cancelled');

  let paymentId;
  let signature;
  if (order.payment.provider === 'mock') {
    if (req.body.outcome === 'failure') throw new ApiError(402, 'Payment was declined by the bank (simulated). You can try again.');
    paymentId = `pay_test_${order._id.toString().slice(-10)}${Date.now().toString(36)}`;
  } else {
    const { razorpay_order_id: gatewayOrderId, razorpay_payment_id: rzpPaymentId, razorpay_signature: rzpSignature } = req.body;
    if (!rzpPaymentId || !rzpSignature || gatewayOrderId !== order.payment.gatewayOrderId) {
      throw new ApiError(400, 'Incomplete payment details');
    }
    if (!verifyPaymentSignature({ gatewayOrderId, paymentId: rzpPaymentId, signature: rzpSignature })) {
      throw new ApiError(400, 'Payment signature verification failed');
    }
    paymentId = rzpPaymentId;
    signature = rzpSignature;
  }

  const paid = await finalizePayment(order._id, { paymentId, signature });
  res.json({ order: paid });
}

/** Razorpay webhook (raw body) — confirms payments even if the customer closes the browser mid-checkout. */
export async function razorpayWebhook(req, res) {
  if (!verifyWebhookSignature(req.body, req.headers['x-razorpay-signature'])) {
    return res.status(400).json({ message: 'Invalid webhook signature' });
  }
  const event = JSON.parse(req.body.toString('utf8'));
  if (['payment.captured', 'order.paid'].includes(event.event)) {
    const payment = event.payload?.payment?.entity;
    const order = payment && (await Order.findOne({ 'payment.gatewayOrderId': payment.order_id }));
    if (order && order.payment.status !== 'paid') {
      await finalizePayment(order._id, { paymentId: payment.id });
      logger.info(`Webhook confirmed payment for ${order.orderNumber}`);
    }
  }
  return res.json({ received: true });
}

export async function listMyOrders(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 10 });
  const filter = { customer: req.user._id };
  if (req.query.status) filter.status = req.query.status;
  const [items, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('orderNumber status pricing payment.status payment.provider createdAt placedAt packages.storeName packages.status packages.items.title packages.items.image packages.items.quantity packages.items.product')
      .lean(),
    Order.countDocuments(filter),
  ]);
  res.json(paginated(items, total, page, limit));
}

async function findOrder(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid order id');
  const order = await Order.findById(id).populate('customer', 'name email phone').lean();
  if (!order) throw new ApiError(404, 'Order not found');
  return order;
}

/** An order is private to the customer who placed it; admins use GET /admin/orders/:id. */
async function ownOrder(req) {
  const order = await findOrder(req.params.id);
  if (String(order.customer._id) !== String(req.user._id)) throw new ApiError(403, 'You can only view your own orders');
  return order;
}

function sendInvoice(order, res) {
  if (!['paid', 'refunded'].includes(order.payment.status)) throw new ApiError(400, 'An invoice is generated once the order is paid');
  streamInvoice(order, order.customer, res);
}

export async function getOrder(req, res) {
  res.json({ order: await ownOrder(req) });
}

export async function invoice(req, res) {
  sendInvoice(await ownOrder(req), res);
}

export async function adminGetOrder(req, res) {
  res.json({ order: await findOrder(req.params.id) });
}

export async function adminInvoice(req, res) {
  sendInvoice(await findOrder(req.params.id), res);
}

/** Customers can cancel until a package ships. Paid orders are refunded package by package. */
export async function cancelOrder(req, res) {
  const order = await Order.findOne({ _id: req.params.id, customer: req.user._id });
  if (!order) throw new ApiError(404, 'Order not found');

  if (order.payment.status === 'pending') {
    order.packages.forEach((pkg) => {
      pkg.status = 'cancelled';
      pkg.timeline.push({ status: 'cancelled', note: 'Cancelled before payment' });
    });
    order.payment.status = 'failed';
    order.status = 'cancelled';
    await order.save();
    return res.json({ order });
  }

  const live = order.packages.filter((p) => p.status !== 'cancelled');
  if (!live.length) throw new ApiError(400, 'This order is already cancelled');
  if (live.some((p) => !['placed', 'packed'].includes(p.status))) {
    throw new ApiError(400, 'Part of this order has already shipped and can no longer be cancelled');
  }
  for (const pkg of live) {
    await transitionPackage(order, pkg, 'cancelled', { note: req.body?.reason ? `Cancelled by customer: ${req.body.reason}` : 'Cancelled by customer' });
  }
  await order.save();
  res.json({ order });
}
