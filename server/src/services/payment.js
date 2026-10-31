import crypto from 'node:crypto';
import Stripe from 'stripe';
import { env, isProd } from '../config/env.js';
import { ApiError } from '../utils/http.js';
import { logger } from '../utils/logger.js';

/**
 * Stripe adapter: PaymentIntents for checkout, refunds, and Connect (Express accounts + transfers) for
 * vendor payouts. Without keys a built-in test gateway runs the same flow without real money.
 * Model: "separate charges and transfers" - the platform charges the customer, and each vendor share is
 * transferred later, once the package's return window has passed.
 */
const { secretKey, publishableKey, webhookSecret, connectWebhookSecret, currency } = env.stripe;
const stripe = secretKey ? new Stripe(secretKey, { maxNetworkRetries: 2 }) : null;

export const CURRENCY = currency;
export const paymentProvider = () => (stripe ? 'stripe' : 'mock');

/** True when the test gateway may be used: always in development, in production only with ALLOW_TEST_GATEWAY=true. */
export const testGatewayAllowed = () => !isProd || env.stripe.allowTestGateway;

/** Called at startup: production without Stripe keys would let anyone "pay" through the test gateway. */
export function assertPaymentConfig() {
  if (!stripe && !testGatewayAllowed()) {
    throw new Error('STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are required in production (or set ALLOW_TEST_GATEWAY=true for a demo deployment without real payments)');
  }
  if (!stripe) return;
  if (!publishableKey) throw new Error('STRIPE_PUBLISHABLE_KEY is required when STRIPE_SECRET_KEY is set');
  // The publishable key is sent to every browser, so a secret key here would leak it (and Stripe.js refuses it).
  if (!/^pk_(test|live)_/.test(publishableKey)) {
    throw new Error('STRIPE_PUBLISHABLE_KEY must be the publishable key (pk_test_... / pk_live_...), not the secret key. Copy it from Developers -> API keys.');
  }
  if (!/^(sk|rk)_(test|live)_/.test(secretKey)) throw new Error('STRIPE_SECRET_KEY must be a secret key (sk_test_... / sk_live_...)');
  if (keyMode(secretKey) !== keyMode(publishableKey)) {
    throw new Error('STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are from different modes (one test, one live). Use both test keys.');
  }
}

const keyMode = (key) => (key.includes('_test_') ? 'test' : 'live');

export function logPaymentProvider() {
  if (stripe) {
    logger.ok(`Payments: Stripe ${secretKey.startsWith('sk_test') ? 'TEST' : 'LIVE'} mode, ${currency.toUpperCase()} (Connect payouts)`);
    if (!webhookSecret) logger.warn('Payments: STRIPE_WEBHOOK_SECRET not set -> webhooks are rejected; payments still confirm via the checkout callback and reconciliation');
  } else if (isProd) {
    logger.warn('Payments: ALLOW_TEST_GATEWAY=true -> production is using the built-in test gateway. Orders can be "paid" without money; never use this for a real store.');
  } else {
    logger.warn('Payments: Stripe keys not set -> using built-in test gateway (same flow, no real money)');
  }
}

/** Stripe amounts are integers in the smallest currency unit (paise for INR). */
export const toMinor = (amount) => Math.round(amount * 100);
const fromMinor = (minor) => minor / 100;
const mockId = (prefix) => `${prefix}_test_${crypto.randomBytes(8).toString('hex')}`;
export const gatewayError = (err) => err?.raw?.message || err?.message || 'Payment gateway error';

/* -------------------------------------------------------------- payments */

/**
 * Opens a payment attempt for an order. The idempotency key is per order and attempt, so a retried
 * request gets the same PaymentIntent back instead of a second one.
 */
/**
 * The user's Stripe Customer, created on their first payment and saved on the user. Without one,
 * Stripe treats payments as guest payments and its dashboard shows no customer.
 */
export async function stripeCustomerFor(user) {
  if (!stripe) return null;
  if (user.stripeCustomerId) return user.stripeCustomerId;
  try {
    const customer = await stripe.customers.create(
      { email: user.email, name: user.name, metadata: { userId: String(user._id) } },
      { idempotencyKey: `customer:${user._id}` },
    );
    user.stripeCustomerId = customer.id;
    await user.save();
    return customer.id;
  } catch (err) {
    throw new ApiError(502, `Could not start payment: ${gatewayError(err)}`);
  }
}

export async function createPaymentIntent({ orderId, orderNumber, amount, email, customerId, attempt = 0 }) {
  if (!stripe) {
    assertPaymentConfig();
    return { provider: 'mock', intentId: mockId('pi'), clientSecret: null };
  }
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: toMinor(amount),
        currency,
        // Cards only: leaves out Stripe Link and its "save my information" box from the payment form.
        payment_method_types: ['card'],
        receipt_email: email,
        ...(customerId && { customer: customerId }),
        description: orderNumber,
        transfer_group: orderNumber,
        metadata: { orderId: String(orderId), orderNumber },
      },
      { idempotencyKey: `pi:${orderId}:${attempt}` },
    );
    return { provider: 'stripe', intentId: intent.id, clientSecret: intent.client_secret };
  } catch (err) {
    throw new ApiError(502, `Could not start payment: ${gatewayError(err)}`);
  }
}

/** Client secret of an existing intent (retry payment from the order page). */
export async function intentClientSecret(intentId) {
  const intent = await stripe.paymentIntents.retrieve(intentId);
  return { status: intent.status, clientSecret: intent.client_secret };
}

/** What the frontend needs to show the payment form. */
export const checkoutConfig = (order, clientSecret) => ({
  provider: order.payment.provider,
  publishableKey: order.payment.provider === 'stripe' ? publishableKey : null,
  clientSecret: clientSecret || null,
  amount: toMinor(order.pricing.total),
  currency,
});

/**
 * Confirms that a payment really holds the money before an order is marked paid: the intent must carry
 * this order id, be for exactly the order amount and currency, and have succeeded. An intent waiting for
 * manual capture is captured here. Throws otherwise; returns { method, chargeId }.
 */
export async function confirmCapture(intentId, { provider, orderId, amount }) {
  if (provider === 'mock') return { method: 'test-gateway', chargeId: null };
  if (!stripe) throw new ApiError(503, 'Stripe is not configured on this server');
  let intent = await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
  if (intent.metadata?.orderId !== String(orderId)) throw new ApiError(400, 'This payment belongs to a different order');
  if (intent.amount !== toMinor(amount) || intent.currency !== currency) {
    throw new ApiError(400, `Payment amount ${fromMinor(intent.amount)} ${intent.currency.toUpperCase()} does not match the order total ${amount} ${currency.toUpperCase()}`);
  }
  if (intent.status === 'requires_capture') intent = await stripe.paymentIntents.capture(intentId, { expand: ['latest_charge'] });
  if (intent.status !== 'succeeded') throw new ApiError(402, `Payment is ${intent.status.replace(/_/g, ' ')}, not completed`);
  const charge = intent.latest_charge;
  return { method: charge?.payment_method_details?.type, chargeId: typeof charge === 'string' ? charge : charge?.id };
}

/** Current state of an intent (reconciliation). */
export const retrieveIntent = (intentId) => stripe.paymentIntents.retrieve(intentId);

/* --------------------------------------------------------------- refunds */

const REFUND_STATUS = { succeeded: 'succeeded', pending: 'pending', requires_action: 'pending', failed: 'failed', canceled: 'failed' };
export const refundStatusOf = (stripeStatus) => REFUND_STATUS[stripeStatus] || 'pending';

/**
 * Refunds part of a payment. `refundId` (our Refund document) goes into the metadata and the idempotency
 * key, so the same attempt can never create two refunds; a retry first looks for an earlier one.
 */
export async function createRefund({ provider, intentId, amount, refundId, attempt }) {
  if (provider === 'mock') return { id: mockId('re'), status: 'succeeded' };
  const refund = await stripe.refunds.create(
    { payment_intent: intentId, amount: toMinor(amount), metadata: { refundId: String(refundId) } },
    { idempotencyKey: `refund:${refundId}:${attempt}` },
  );
  return { id: refund.id, status: refundStatusOf(refund.status), providerStatus: refund.status, error: refund.failure_reason };
}

/** A refund this platform already created for a Refund document (lost response, crash before saving). */
export async function findRefund({ provider, intentId, refundId, providerRefundId }) {
  if (provider === 'mock') return null;
  const refund = providerRefundId
    ? await stripe.refunds.retrieve(providerRefundId)
    : (await stripe.refunds.list({ payment_intent: intentId, limit: 100 })).data.find((r) => r.metadata?.refundId === String(refundId));
  return refund ? { id: refund.id, status: refundStatusOf(refund.status), providerStatus: refund.status, error: refund.failure_reason } : null;
}

/* ------------------------------------------------------- Connect payouts */

/**
 * Pays a vendor share to their connected account, funded by the order charge (source_transaction), so it
 * never depends on the platform balance. A retry first looks for an earlier transfer of the package.
 */
export async function createTransfer({ destination, amount, chargeId, orderNumber, packageId, attempt }) {
  const existing = await stripe.transfers.list({ destination, transfer_group: orderNumber, limit: 100 });
  const earlier = existing.data.find((t) => t.metadata?.packageId === String(packageId));
  if (earlier) return { id: earlier.id };
  const transfer = await stripe.transfers.create(
    {
      amount: toMinor(amount),
      currency,
      destination,
      transfer_group: orderNumber,
      ...(chargeId ? { source_transaction: chargeId } : {}),
      metadata: { orderNumber, packageId: String(packageId) },
    },
    { idempotencyKey: `payout:${packageId}:${attempt}` },
  );
  return { id: transfer.id };
}

/** Pulls (part of) a vendor transfer back. Returns { ok } or { ok: false, error }; never pretends. */
export async function reverseTransfer(transferId, amount, idempotencyKey) {
  if (!stripe || !transferId) return { ok: true };
  try {
    await stripe.transfers.createReversal(transferId, { amount: toMinor(amount) }, { idempotencyKey });
    return { ok: true };
  } catch (err) {
    const error = gatewayError(err);
    logger.warn(`Stripe transfer reversal failed: ${error}`);
    return { ok: false, error };
  }
}

/** Creates the Express account a vendor completes on Stripe's hosted onboarding. */
export async function createConnectAccount({ vendorId, email, storeName }) {
  if (!stripe) throw new ApiError(503, 'Stripe is not configured on this server');
  const account = await stripe.accounts.create({
    type: 'express',
    ...(env.stripe.connectCountry ? { country: env.stripe.connectCountry } : {}),
    email,
    business_profile: { name: storeName },
    capabilities: { transfers: { requested: true } },
    metadata: { vendorId: String(vendorId) },
  });
  return account.id;
}

/** One-time link to Stripe's hosted onboarding (or to finish it). */
export async function onboardingLink(accountId, { refreshUrl, returnUrl }) {
  const link = await stripe.accountLinks.create({ account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
  return link.url;
}

/** Login link to the vendor's Express dashboard (balances, payouts, bank account). */
export async function dashboardLink(accountId) {
  return (await stripe.accounts.createLoginLink(accountId)).url;
}

/** Verified state of a connected account, straight from Stripe. */
export async function accountStatus(accountId) {
  const account = await stripe.accounts.retrieve(accountId);
  return {
    accountId: account.id,
    detailsSubmitted: Boolean(account.details_submitted),
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    transfersActive: account.capabilities?.transfers === 'active',
    syncedAt: new Date(),
  };
}

export const connectAvailable = () => Boolean(stripe);

/* --------------------------------------------------------------- webhooks */

/** Verifies the Stripe-Signature header against the raw body; returns the event or throws. */
export function constructWebhookEvent(rawBody, signature) {
  // Account events and Connect (connected-account) events may come from two endpoints with two secrets.
  const secrets = [webhookSecret, connectWebhookSecret].filter(Boolean);
  if (!stripe || !secrets.length) throw new ApiError(400, 'Stripe webhooks are not configured');
  let lastError;
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      lastError = err;
    }
  }
  throw new ApiError(400, `Invalid webhook signature: ${lastError.message}`);
}
