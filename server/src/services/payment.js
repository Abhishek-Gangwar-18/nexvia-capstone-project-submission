import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { keyId, keySecret, webhookSecret } = env.razorpay;
const razorpay = keyId && keySecret ? new Razorpay({ key_id: keyId, key_secret: keySecret }) : null;

export const paymentProvider = () => (razorpay ? 'razorpay' : 'mock');

export function logPaymentProvider() {
  if (razorpay) logger.ok(`Payments: Razorpay ${keyId.startsWith('rzp_test') ? 'TEST' : 'LIVE'} mode (Route split payments)`);
  else logger.warn('Payments: Razorpay keys not set -> using built-in test gateway (same flow, no real money)');
}

const gatewayError = (err) => err?.error?.description || err?.message || 'Payment gateway error';
const toPaise = (rupees) => Math.round(rupees * 100);

/**
 * Creates a gateway order. With Razorpay Route, `transfers` split the payment to vendor linked accounts
 * at capture time (held until delivery). If Route is not enabled on the account, falls back to a plain
 * order and the split is settled manually from the ledger.
 */
export async function createGatewayOrder({ amount, receipt, notes, transfers = [] }) {
  if (!razorpay) {
    return { provider: 'mock', id: `mock_order_${crypto.randomBytes(8).toString('hex')}`, amount: toPaise(amount), currency: 'INR', splitApplied: false };
  }
  const base = { amount: toPaise(amount), currency: 'INR', receipt, notes };
  if (transfers.length) {
    try {
      const order = await razorpay.orders.create({
        ...base,
        transfers: transfers.map((t) => ({
          account: t.account,
          amount: toPaise(t.amount),
          currency: 'INR',
          notes: t.notes,
          on_hold: 1,
        })),
      });
      return { provider: 'razorpay', id: order.id, amount: order.amount, currency: order.currency, splitApplied: true };
    } catch (err) {
      logger.warn(`Razorpay Route split rejected (${gatewayError(err)}) -> creating order without transfers`);
    }
  }
  try {
    const order = await razorpay.orders.create(base);
    return { provider: 'razorpay', id: order.id, amount: order.amount, currency: order.currency, splitApplied: false };
  } catch (err) {
    throw new Error(gatewayError(err));
  }
}

/** Checkout options the frontend needs to open the payment UI. */
export const checkoutConfig = (order) => ({
  provider: order.payment.provider,
  keyId: order.payment.provider === 'razorpay' ? keyId : null,
  gatewayOrderId: order.payment.gatewayOrderId,
  amount: toPaise(order.pricing.total),
  currency: 'INR',
});

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export function verifyPaymentSignature({ gatewayOrderId, paymentId, signature }) {
  if (!keySecret) return false;
  const expected = crypto.createHmac('sha256', keySecret).update(`${gatewayOrderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, signature);
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!webhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
}

export async function fetchPaymentMethod(paymentId) {
  if (!razorpay) return 'test-gateway';
  try {
    const payment = await razorpay.payments.fetch(paymentId);
    return payment.method;
  } catch {
    return undefined;
  }
}

/** Route transfers created for a payment, keyed by linked account id. */
export async function fetchTransfers(paymentId) {
  if (!razorpay) return new Map();
  try {
    const res = await razorpay.payments.fetchTransfer(paymentId);
    return new Map((res.items || []).map((t) => [t.recipient, t]));
  } catch (err) {
    logger.warn(`Could not fetch Route transfers: ${gatewayError(err)}`);
    return new Map();
  }
}

/** Releases a held Route transfer to the vendor (called when a package is delivered). */
export async function releaseTransfer(transferId) {
  if (!razorpay || !transferId) return true;
  try {
    await razorpay.transfers.edit(transferId, { on_hold: 0 });
    return true;
  } catch (err) {
    logger.warn(`Route transfer release failed: ${gatewayError(err)}`);
    return false;
  }
}

/** Pulls a vendor's (held) Route transfer back to the platform account, e.g. when their package is cancelled. */
export async function reverseTransfer(transferId, amount) {
  if (!razorpay || !transferId) return true;
  try {
    await razorpay.transfers.reverse(transferId, { amount: toPaise(amount) });
    return true;
  } catch (err) {
    logger.warn(`Route transfer reversal failed: ${gatewayError(err)}`);
    return false;
  }
}

/** Refunds (part of) a payment back to the customer. */
export async function refundPayment(paymentId, amount) {
  if (!razorpay) return { id: `mock_refund_${crypto.randomBytes(6).toString('hex')}`, status: 'processed' };
  const refund = await razorpay.payments.refund(paymentId, { amount: toPaise(amount), speed: 'normal' });
  return { id: refund.id, status: refund.status };
}
