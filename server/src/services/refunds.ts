import { Payment } from '../models/Payment.ts';
import { Refund } from '../models/Refund.ts';
import { Order } from '../models/Order.ts';
import { withLock } from './locks.ts';
import { CURRENCY, createRefund, findRefund, gatewayError } from './payment.ts';
import { ApiError, round2 } from '../utils/http.ts';
import { logger } from '../utils/logger.ts';

/** Package summaries keep their historical vocabulary: processed | pending | failed. */
const SUMMARY_STATUS = { succeeded: 'processed', pending: 'pending', failed: 'failed' };

/** Provider reference of the payment to refund: the succeeded attempt, or the order summary (older orders). */
async function paidIntent(order) {
  const payment = await Payment.findOne({ order: order._id, status: 'succeeded' }).select('_id intentId').lean();
  return { paymentId: payment?._id, intentId: payment?.intentId || order.payment.paymentId };
}

const withRefundLock = (refundId, fn) => withLock(`refund:${refundId}`, 60, 'This refund is already being processed', fn);

/**
 * Sends one attempt to the gateway. A retry first asks Stripe whether an earlier attempt already went
 * through (the response may have been lost), so a refund is never paid twice.
 */
async function attempt(refund, intentId) {
  const known = refund.attempts > 0 || refund.providerRefundId
    ? await findRefund({ provider: refund.provider, intentId, refundId: refund._id, providerRefundId: refund.providerRefundId }).catch(() => null)
    : null;
  if (known) {
    Object.assign(refund, { providerRefundId: known.id, status: known.status, providerStatus: known.providerStatus, lastError: known.error });
  } else {
    refund.attempts += 1;
    try {
      const result = await createRefund({ provider: refund.provider, intentId, amount: refund.amount, refundId: refund._id, attempt: refund.attempts });
      Object.assign(refund, { providerRefundId: result.id, status: result.status, providerStatus: result.providerStatus, lastError: result.error });
    } catch (err) {
      refund.status = 'failed';
      refund.lastError = gatewayError(err);
      logger.error(`Refund ${refund._id} (${refund.amount}) failed: ${refund.lastError}`);
    }
  }
  await refund.save();
  return refund;
}

/** Recomputes a package refund summary from its Refund documents (the source of truth). */
export async function syncPackageRefund(order, pkg) {
  const refunds = await Refund.find({ order: order._id, package: pkg._id }).sort({ createdAt: 1 }).lean();
  if (!refunds.length) return;
  const worst = ['failed', 'pending', 'succeeded'].find((s) => refunds.some((r) => r.status === s));
  const failed = refunds.filter((r) => r.status === 'failed');
  const latest = refunds[refunds.length - 1];
  // A failed summary shows the amount still owed; otherwise the amount refunded (or on its way).
  const counted = worst === 'failed' ? failed : refunds.filter((r) => r.status !== 'failed');
  pkg.refund = {
    id: latest.providerRefundId,
    amount: round2(counted.reduce((s, r) => s + r.amount, 0)),
    status: SUMMARY_STATUS[worst],
    error: failed.at(-1)?.lastError,
    at: latest.updatedAt,
  };
}

const units = (pkg) => pkg.items.reduce((sum, item) => sum + item.quantity, 0);
/** Nothing of this package is kept: it was cancelled, or every unit came back in a refunded return. */
const givenBack = (pkg) => pkg.status === 'cancelled' || (pkg.status === 'delivered' && (pkg.returned?.quantity || 0) >= units(pkg));

/**
 * paid -> refunded only when no package is kept (all cancelled or fully returned) and every refund has
 * gone through. A partial refund leaves it "paid"; the package refund summaries show what came back.
 */
export function settlePaymentStatus(order) {
  if (!['paid', 'refunded'].includes(order.payment.status)) return;
  const allRefunded = order.packages.every((p) => !p.refund?.status || p.refund.status === 'processed');
  order.payment.status = order.packages.every(givenBack) && allRefunded ? 'refunded' : 'paid';
}

/**
 * Refunds money for one package (cancellation, return or an unfulfillable order). The Refund document
 * is written first; the order document passed in gets its package summary updated (caller saves it).
 */
export async function issueRefund({ order, pkg, amount, reason, initiatedBy, returnRequest }: Record<string, any>) {
  const value = round2(amount);
  if (value <= 0) return null;
  const { paymentId, intentId } = await paidIntent(order);
  const refund = await Refund.create({
    order: order._id,
    package: pkg._id,
    payment: paymentId,
    provider: order.payment.provider,
    amount: value,
    currency: order.payment.currency || CURRENCY,
    reason,
    initiatedBy,
    returnRequest,
  });
  // No lock for a brand-new refund: nobody else knows its id yet, and even a retry racing this first attempt
  // sends the same Stripe idempotency key. Skipping it also means a Redis outage can't strand the refund.
  await attempt(refund, intentId);
  await syncPackageRefund(order, pkg);
  return refund;
}

/** Admin retry of a failed (or stuck pending) refund. Safe to repeat. */
export async function retryRefund(refundId) {
  const refund = await Refund.findById(refundId);
  if (!refund) throw new ApiError(404, 'Refund not found');
  if (refund.status === 'succeeded') throw new ApiError(400, 'This refund has already gone through');
  const order = await Order.findById(refund.order);
  const { intentId } = await paidIntent(order);
  await withRefundLock(refund._id, () => attempt(refund, intentId));
  await applyRefundToOrder(refund);
  return refund;
}

/** Copies a refund status change (retry, webhook, reconciliation) onto its order. */
export async function applyRefundToOrder(refund) {
  const order = await Order.findById(refund.order);
  const pkg = order?.packages.id(refund.package);
  if (!pkg) return null;
  await syncPackageRefund(order, pkg);
  settlePaymentStatus(order);
  order.recomputeStatus();
  await order.save();
  // A return whose refund failed first completes once a retry (or Stripe) confirms the money moved.
  if (refund.returnRequest && refund.status !== 'failed') {
    const { completeReturn } = await import('./returns.ts');
    await completeReturn(refund.returnRequest);
  }
  return order;
}

/** Webhook / reconciliation: the gateway reports a refund state. */
export async function syncRefundFromProvider({ providerRefundId, refundId, status, providerStatus, error }) {
  const refund = providerRefundId ? await Refund.findOne({ providerRefundId }) : null;
  const target = refund || (refundId ? await Refund.findById(refundId) : null);
  if (!target) return null;
  if (target.status === status && target.providerRefundId === providerRefundId) return target;
  Object.assign(target, { status, providerStatus, lastError: error, ...(providerRefundId ? { providerRefundId } : {}) });
  await target.save();
  await applyRefundToOrder(target);
  return target;
}
