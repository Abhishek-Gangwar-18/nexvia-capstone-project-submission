import { Payment } from '../models/Payment.js';
import { Refund } from '../models/Refund.js';
import { finalizePayment, recordPaymentEvent, recordPaymentFailure } from './orders.js';
import { resetStaleClaims } from './payouts.js';
import { applyRefundToOrder } from './refunds.js';
import { findRefund, paymentProvider, retrieveIntent } from './payment.js';
import { logger } from '../utils/logger.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Payment attempts Stripe has settled but we never heard about (closed tab, lost webhook). */
async function reconcilePayments(report) {
  const stale = await Payment.find({ provider: 'stripe', status: { $in: ['created', 'processing'] }, updatedAt: { $lt: new Date(Date.now() - 5 * MINUTE), $gt: new Date(Date.now() - 3 * DAY) } })
    .limit(100)
    .lean();
  for (const payment of stale) {
    try {
      const intent = await retrieveIntent(payment.intentId);
      if (intent.status === 'succeeded') {
        await finalizePayment(payment.order, { intentId: payment.intentId });
        report.paymentsFinalized += 1;
      } else if (intent.status === 'canceled') {
        await recordPaymentEvent(payment.intentId, { status: 'canceled', type: 'reconciled' });
      } else if (intent.last_payment_error) {
        await recordPaymentFailure(payment.intentId, intent.last_payment_error.message);
      }
    } catch (err) {
      report.errors.push(`payment ${payment.intentId}: ${err.message}`);
    }
  }
}

/**
 * Refunds whose outcome we don't know for sure: pending ones, and failed ones Stripe may in fact have
 * made (the response was lost). Each is looked up by its own id - never re-sent from here.
 */
async function reconcileRefunds(report) {
  const open = await Refund.find({ provider: 'stripe', status: { $in: ['pending', 'failed'] }, updatedAt: { $gt: new Date(Date.now() - 30 * DAY) } }).limit(200);
  for (const refund of open) {
    try {
      const payment = refund.payment ? await Payment.findById(refund.payment).select('intentId').lean() : null;
      const found = await findRefund({ provider: refund.provider, intentId: payment?.intentId, refundId: refund._id, providerRefundId: refund.providerRefundId });
      if (!found || (found.status === refund.status && found.id === refund.providerRefundId)) continue;
      Object.assign(refund, { providerRefundId: found.id, status: found.status, providerStatus: found.providerStatus, lastError: found.error });
      await refund.save();
      await applyRefundToOrder(refund);
      report.refundsUpdated += 1;
    } catch (err) {
      report.errors.push(`refund ${refund._id}: ${err.message}`);
    }
  }
}

/**
 * Compares Stripe with the database and repairs what is safe to repair: payments that succeeded without
 * us knowing, refunds whose final state we missed, payouts abandoned mid-transfer. Runs every 6 hours
 * and on demand (POST /admin/payments/reconcile). Anything it can't fix shows up in the admin exceptions.
 */
export async function runReconciliation() {
  const report = { paymentsFinalized: 0, refundsUpdated: 0, payoutClaimsReset: 0, errors: [] };
  report.payoutClaimsReset = await resetStaleClaims();
  if (paymentProvider() === 'stripe') {
    await reconcilePayments(report);
    await reconcileRefunds(report);
  }
  if (report.paymentsFinalized || report.refundsUpdated || report.payoutClaimsReset || report.errors.length) {
    logger.info(`Reconciliation: ${report.paymentsFinalized} payments finalized, ${report.refundsUpdated} refunds updated, ${report.payoutClaimsReset} payout claims reset, ${report.errors.length} errors`);
  }
  return report;
}
