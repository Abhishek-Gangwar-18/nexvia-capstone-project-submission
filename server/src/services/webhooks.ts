import { Payment } from '../models/Payment.ts';
import { Vendor } from '../models/Vendor.ts';
import { WebhookEvent } from '../models/WebhookEvent.ts';
import { finalizePayment, recordPaymentEvent, recordPaymentFailure } from './orders.ts';
import { freezePayoutsIfPending } from './payouts.ts';
import { syncRefundFromProvider } from './refunds.ts';
import { refundStatusOf } from './payment.ts';
import { logger } from '../utils/logger.ts';

/** The order a PaymentIntent belongs to: our Payment record first, the intent metadata as a fallback. */
async function orderOfIntent(intent) {
  const payment = await Payment.findOne({ intentId: intent.id }).select('order').lean();
  return payment?.order || intent.metadata?.orderId;
}

const HANDLERS = {
  'payment_intent.succeeded': async (intent) => {
    const orderId = await orderOfIntent(intent);
    if (orderId) await finalizePayment(orderId, { intentId: intent.id });
  },
  'payment_intent.processing': (intent) => recordPaymentEvent(intent.id, { status: 'processing', type: 'processing' }),
  'payment_intent.payment_failed': (intent) => recordPaymentFailure(intent.id, intent.last_payment_error?.message || 'Payment failed'),
  'payment_intent.canceled': (intent) => recordPaymentEvent(intent.id, { status: 'canceled', type: 'canceled', detail: intent.cancellation_reason }),

  // Refunds can stay pending for days (bank transfers) and fail later: the final state arrives here.
  'refund.created': syncRefund,
  'refund.updated': syncRefund,
  'refund.failed': syncRefund,
  'charge.refund.updated': syncRefund,

  // Connect: the vendor finished (or lost) onboarding, or changed the bank account inside Stripe.
  'account.updated': async (account) => {
    await Vendor.updateOne(
      { 'stripe.accountId': account.id },
      {
        $set: {
          'stripe.detailsSubmitted': Boolean(account.details_submitted),
          'stripe.chargesEnabled': Boolean(account.charges_enabled),
          'stripe.payoutsEnabled': Boolean(account.payouts_enabled),
          'stripe.syncedAt': new Date(),
        },
      },
    );
  },
  'account.external_account.created': bankChanged,
  'account.external_account.updated': bankChanged,
  'account.external_account.deleted': bankChanged,
};

function syncRefund(refund) {
  return syncRefundFromProvider({
    providerRefundId: refund.id,
    refundId: refund.metadata?.refundId,
    status: refundStatusOf(refund.status),
    providerStatus: refund.status,
    error: refund.failure_reason,
  });
}

/** #9(d): a new bank account on the connected account freezes payouts that are still waiting. */
async function bankChanged(_externalAccount, event) {
  const vendor = await Vendor.findOne({ 'stripe.accountId': event.account }).select('_id storeName').lean();
  if (vendor) await freezePayoutsIfPending(vendor, 'Bank account changed in Stripe');
}

/**
 * Processes one verified Stripe event at most once. The event id is stored first: a redelivered event
 * that was already processed is skipped; one whose earlier delivery failed is processed again (every
 * handler is idempotent). A handler error is rethrown so Stripe retries the delivery.
 */
export async function handleStripeEvent(event) {
  let record;
  try {
    record = await WebhookEvent.create({ eventId: event.id, type: event.type });
  } catch (err) {
    if (err.code !== 11000) throw err;
    record = await WebhookEvent.findOne({ eventId: event.id });
    if (record?.processedAt) return { duplicate: true };
  }
  const handler = HANDLERS[event.type];
  try {
    if (handler) await handler(event.data.object, event);
    await WebhookEvent.updateOne({ _id: record._id }, { $set: { processedAt: new Date() }, $unset: { error: '' } });
    return { handled: Boolean(handler) };
  } catch (err) {
    logger.error(`Stripe webhook ${event.type} (${event.id}) failed: ${err.message}`);
    await WebhookEvent.updateOne({ _id: record._id }, { $set: { error: err.message } });
    throw err;
  }
}
