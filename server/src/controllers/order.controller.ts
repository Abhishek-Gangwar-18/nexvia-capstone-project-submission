import mongoose from 'mongoose';
import { z } from 'zod';
import { Order } from '../models/Order.ts';
import { User } from '../models/User.ts';
import { Vendor } from '../models/Vendor.ts';
import { cache } from '../services/cache.ts';
import { addressSchema } from './auth.controller.ts';
import { getCart } from '../services/cart.ts';
import { applyCommission, distributeDiscount, evaluateCoupon, getSettings, shippingFor } from '../services/pricing.ts';
import { Payment } from '../models/Payment.ts';
import { Refund } from '../models/Refund.ts';
import {
  checkoutConfig,
  constructWebhookEvent,
  createPaymentIntent,
  stripeCustomerFor,
  CURRENCY,
  intentClientSecret,
  paymentProvider,
  testGatewayAllowed,
} from '../services/payment.ts';
import { handleStripeEvent } from '../services/webhooks.ts';
import { RETURN_WINDOW_DAYS } from '../services/payouts.ts';
import { withLock } from '../services/locks.ts';
import {
  afterStockChange,
  cancelUnpaidOrder,
  finalizePayment,
  recordPaymentFailure,
  newOrderNumber,
  releaseStock,
  reserveStock,
  RESERVATION_MINUTES,
  transitionPackage,
} from '../services/orders.ts';
import { streamInvoice } from '../services/invoice.ts';
import { ApiError, paginated, parsePagination, round2 } from '../utils/http.ts';
import { logger } from '../utils/logger.ts';
import { holdCoupon, releaseCoupon } from '../services/coupons.ts';
import { cancelReason } from '../utils/validators.ts';

const customerCancelSchema = cancelReason('customer');

export const checkoutSchema = z
  .object({
    addressId: z.string().optional(),
    address: addressSchema.optional(),
    couponCode: z.string().trim().max(30).optional(),
    /** The total the customer saw. If the server's total differs (price, delivery fee or coupon changed), checkout stops. */
    expectedTotal: z.coerce.number().min(0).optional(),
  })
  .refine((d) => d.addressId || d.address, { message: 'Choose a delivery address', path: ['address'] });

export const verifySchema = z.object({
  /** Stripe: the PaymentIntent the client confirmed. */
  paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9_]+$/, 'Invalid payment id').optional(),
  /** Only used by the built-in test gateway to simulate success or a declined card. */
  outcome: z.enum(['success', 'failure']).optional(),
});

export const cancelSchema = z.object({
  /** Packages to cancel; left out = every package that can still be cancelled. */
  packageIds: z.array(z.string().regex(/^[a-f\d]{24}$/i, 'Invalid package id')).min(1).max(20).optional(),
  reasonCode: z.string().optional(),
  note: z.string().trim().max(200).optional(),
  /** Older clients send a free-text reason only. */
  reason: z.string().trim().max(200).optional(),
});

const prefill = (user) => ({ name: user.name, email: user.email, contact: user.phone || '' });

/**
 * Creates an order from the cart: groups items into one package per vendor, applies the coupon,
 * computes the platform commission and vendor earnings per package, and opens a Stripe PaymentIntent.
 * The platform collects the whole payment; each vendor share is transferred after delivery + the
 * return window (services/payouts.ts).
 */
async function placeOrder(req) {
  const userId = req.user._id;
  const cart = await getCart(userId);
  // Products that stopped being sold since the customer last saw the cart: say so instead of ordering without them.
  if (cart.removed.length) {
    const names = cart.removed.map((r) => r.title).join(', ');
    throw new ApiError(409, `No longer available: ${names}. It has been removed from your cart, please review it.`, { code: 'CART_CHANGED' });
  }
  if (!cart.items.length) throw new ApiError(400, 'Your cart is empty');
  if (cart.items.some((i) => !i.inStock)) throw new ApiError(400, 'Remove out-of-stock items from your cart to continue');
  // Stock dropped below what the customer chose: stop instead of silently ordering fewer than they saw.
  const short = cart.items.filter((i) => i.limited);
  if (short.length) {
    const lines = short.map((i) => `${i.product.title} (only ${i.quantity} left)`).join(', ');
    throw new ApiError(409, `Stock changed: ${lines}. Your cart has been updated, please review it.`, { code: 'CART_CHANGED' });
  }

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

  // The amount must be what the customer agreed to: a price, delivery fee or coupon that changed since the
  // page was loaded stops checkout here, before any stock or coupon is held.
  if (req.body.expectedTotal != null && Math.abs(req.body.expectedTotal - total) >= 0.01) {
    const repriced = cart.items.filter((i) => i.priceChanged).map((i) => `${i.product.title} ₹${i.priceChanged.from} → ₹${i.priceChanged.to}`);
    const why = repriced.length ? ` (${repriced.join(', ')})` : ' (price, delivery fee or coupon updated)';
    throw new ApiError(409, `Your total changed from ₹${req.body.expectedTotal} to ₹${total}${why}. Please review your order.`, {
      code: 'CART_CHANGED',
      expectedTotal: req.body.expectedTotal,
      total,
    });
  }

  const order = new Order({
    customer: userId,
    packages,
    shippingAddress,
    pricing: { subtotal, discount, shipping, total },
    coupon: coupon ? { id: coupon.coupon._id, code: coupon.coupon.code, discount, vendor: coupon.vendorId } : undefined,
    payment: { provider: paymentProvider(), status: 'pending', currency: CURRENCY },
    reservation: { status: 'held', expiresAt: new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000) },
  });

  // Hold the stock first (atomic per line), then persist the order. Nothing has been sent to the
  // payment gateway yet, so an order-number collision can simply be retried.
  const items = order.packages.flatMap((p) => p.items);
  await reserveStock(items);
  let saved = false;
  let clientSecret;
  try {
    if (coupon) await holdCoupon(coupon.coupon, userId, order._id);
    await insertWithUniqueNumber(order);
    saved = true;
    clientSecret = await openPayment(order, req.user);
  } catch (err) {
    await releaseStock(items);
    if (coupon) await releaseCoupon(order._id);
    if (saved) await Order.deleteOne({ _id: order._id });
    throw err;
  }
  await afterStockChange(items);

  return {
    order: { _id: order._id, orderNumber: order.orderNumber, pricing: order.pricing },
    payment: checkoutConfig(order, clientSecret),
    prefill: prefill(req.user),
  };
}

const ORDER_NUMBER_ATTEMPTS = 5;

/** Inserts the order, regenerating orderNumber on a unique-index collision (bounded retry). */
async function insertWithUniqueNumber(order) {
  for (let attempt = 1; ; attempt++) {
    order.orderNumber = newOrderNumber();
    try {
      await order.save();
      return;
    } catch (err) {
      if (err.code !== 11000 || !err.keyPattern?.orderNumber || attempt >= ORDER_NUMBER_ATTEMPTS) throw err;
    }
  }
}

/**
 * Opens a payment attempt (Stripe PaymentIntent, or the test gateway) and records it as a Payment.
 * Returns the client secret the browser needs to show the Stripe payment form.
 */
async function openPayment(order, user, attempt = 0) {
  const account = await User.findById(user._id).select('+stripeCustomerId name email');
  const customerId = await stripeCustomerFor(account);
  const intent = await createPaymentIntent({ orderId: order._id, orderNumber: order.orderNumber, amount: order.pricing.total, email: account.email, customerId, attempt });
  await Payment.create({
    order: order._id,
    customer: order.customer,
    provider: intent.provider,
    intentId: intent.intentId,
    amount: order.pricing.total,
    currency: CURRENCY,
    events: [{ type: 'created', status: 'created' }],
  });
  order.payment.provider = intent.provider;
  order.payment.intentId = intent.intentId;
  order.packages.forEach((pkg) => {
    pkg.payout = { mode: 'manual', status: 'pending' };
  });
  await order.save();
  return intent.clientSecret;
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
  const resultKey = `idem:checkout:${req.user._id}:${key}:result`;
  const saved = await cache.getJSON(resultKey);
  if (saved) return res.status(201).json(saved);
  // One checkout per customer at a time (double click, or a second tab with its own key): the lock is per
  // customer, not per key. A failed attempt releases it without a result, so the customer can fix and retry.
  return withLock(`checkout:${req.user._id}`, 60, 'A checkout is already in progress (maybe in another tab). Please wait a moment.', async () => {
    // Checked again under the lock: the first attempt may have finished between the check above and now.
    const done = await cache.getJSON(resultKey);
    if (done) return res.status(201).json(done);
    const result = await placeOrder(req);
    await cache.setJSON(resultKey, result, IDEMPOTENCY_TTL);
    return res.status(201).json(result);
  });
}

/**
 * Payment form for an order still awaiting payment (retry from the order page). A Stripe intent that is
 * still usable is reused; a cancelled one (or a switch from the test gateway) gets a new attempt.
 */
export async function paymentConfig(req, res) {
  const order = await Order.findOne({ _id: req.params.id, customer: req.user._id });
  if (!order) throw new ApiError(404, 'Order not found');
  if (order.payment.status === 'paid') throw new ApiError(400, 'This order is already paid');
  if (order.status === 'cancelled') throw new ApiError(400, 'This order was cancelled');

  let clientSecret = null;
  if (order.payment.provider === 'stripe' && paymentProvider() === 'stripe' && order.payment.intentId) {
    const current = await intentClientSecret(order.payment.intentId);
    if (current.status === 'succeeded') {
      return res.json({ order: await finalizePayment(order._id, { intentId: order.payment.intentId }), alreadyPaid: true });
    }
    if (current.status !== 'canceled') clientSecret = current.clientSecret;
  }
  if (!clientSecret && (order.payment.provider !== paymentProvider() || paymentProvider() === 'stripe')) {
    const attempts = await Payment.countDocuments({ order: order._id });
    clientSecret = await openPayment(order, req.user, attempts);
  }
  res.json({ order: { _id: order._id, orderNumber: order.orderNumber, pricing: order.pricing }, payment: checkoutConfig(order, clientSecret), prefill: prefill(req.user) });
}

/**
 * Called by the browser after Stripe confirmed the payment (or the test gateway simulated it). The
 * payment is checked with Stripe itself before anything is marked paid; the webhook is the backup path.
 */
export async function verifyPayment(req, res) {
  const order = await Order.findOne({ _id: req.params.id, customer: req.user._id });
  if (!order) throw new ApiError(404, 'Order not found');
  if (order.payment.status === 'paid') return res.json({ order });
  if (order.status === 'cancelled') throw new ApiError(400, 'This order was cancelled');

  const intentId = order.payment.intentId;
  if (order.payment.provider === 'mock') {
    // Second line of defence: the simulated "success" must never settle an order in a real store.
    if (!testGatewayAllowed()) throw new ApiError(503, 'Test payments are disabled on this server');
    if (req.body.outcome === 'failure') {
      await recordPaymentFailure(intentId, 'Declined by the bank (simulated)');
      throw new ApiError(402, 'Payment was declined by the bank (simulated). You can try again.');
    }
  } else {
    // Only the current attempt of this order can settle it.
    if (!req.body.paymentIntentId || req.body.paymentIntentId !== intentId) throw new ApiError(400, 'This payment does not belong to the order');
  }

  const paid = await finalizePayment(order._id, { intentId });
  res.json({ order: paid });
}

/**
 * Stripe webhook (raw body, Stripe-Signature verified). Confirms payments even if the customer closed the
 * browser, tracks refund outcomes, vendor onboarding and bank changes. Duplicates are skipped.
 */
export async function stripeWebhook(req, res) {
  const event = constructWebhookEvent(req.body, req.headers['stripe-signature']);
  const result = await handleStripeEvent(event);
  return res.json({ received: true, ...result });
}

export async function listMyOrders(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 10 });
  const filter: Record<string, any> = { customer: req.user._id };
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

/** The customer's view of an order's refunds: no gateway ids or errors, just what came back and its state. */
async function customerRefunds(order) {
  const refunds = await Refund.find({ order: order._id }).select('package amount status reason createdAt').sort({ createdAt: 1 }).lean();
  const storeOf = new Map(order.packages.map((p) => [String(p._id), p.storeName]));
  return refunds.map((r) => ({ _id: r._id, storeName: storeOf.get(String(r.package)), amount: r.amount, status: r.status, reason: r.reason, createdAt: r.createdAt }));
}

export async function getOrder(req, res) {
  const order = await ownOrder(req);
  res.json({ order, refunds: await customerRefunds(order), returnWindowDays: RETURN_WINDOW_DAYS });
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

/**
 * POST /orders/:id/cancel { packageIds?, reasonCode, note }. An unpaid order is cancelled as a whole.
 * A paid order: the chosen packages (default: all that haven't shipped) are cancelled and each one is
 * refunded on its own; shipping is refunded with the last live package.
 */
export async function cancelOrder(req, res) {
  const order = await Order.findOne({ _id: req.params.id, customer: req.user._id });
  if (!order) throw new ApiError(404, 'Order not found');
  const { packageIds, reasonCode, note: givenNote, reason: legacyReason } = req.body || {};
  const parsed = customerCancelSchema.safeParse({ reasonCode: reasonCode || (legacyReason ? 'other' : 'changed_mind'), note: givenNote || legacyReason });
  if (!parsed.success) throw new ApiError(400, parsed.error.issues[0].message);
  const reason = parsed.data;

  if (['pending', 'failed'].includes(order.payment.status)) {
    if (packageIds) throw new ApiError(400, 'An unpaid order can only be cancelled as a whole');
    // Atomic: releases the held stock once, and loses cleanly to a payment being confirmed right now.
    const cancelled = await cancelUnpaidOrder(order._id, { note: reason.note || 'Cancelled before payment', cancellation: { by: 'customer', actorId: req.user._id, ...reason } });
    if (cancelled) return res.json({ order: cancelled });
    return res.json({ order: await Order.findById(order._id) });
  }

  const live = order.packages.filter((p) => p.status !== 'cancelled');
  if (!live.length) throw new ApiError(400, 'This order is already cancelled');
  const targets = packageIds ? packageIds.map((id) => order.packages.id(id)) : live;
  if (targets.some((p) => !p)) throw new ApiError(404, 'Package not found in this order');
  if (targets.some((p) => p.status === 'cancelled')) throw new ApiError(400, 'One of these packages is already cancelled');
  if (targets.some((p) => !['placed', 'packed'].includes(p.status))) {
    throw new ApiError(400, packageIds ? 'A package that has shipped can no longer be cancelled' : 'Part of this order has already shipped. Choose the packages to cancel.');
  }
  for (const pkg of targets) {
    await transitionPackage(order, pkg, 'cancelled', {
      note: reason.note ? `Cancelled by customer: ${reason.note}` : 'Cancelled by customer',
      cancellation: { by: 'customer', actorId: req.user._id, ...reason },
    });
  }
  await order.save();
  res.json({ order });
}
