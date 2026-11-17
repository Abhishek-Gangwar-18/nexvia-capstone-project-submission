import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.ts';
import { Refund, REFUND_STATUSES } from '../models/Refund.ts';
import { User } from '../models/User.ts';
import { Vendor } from '../models/Vendor.ts';
import { accountStatus, connectAvailable, createConnectAccount, dashboardLink, onboardingLink } from '../services/payment.ts';
import { freezePayoutsIfPending, releaseDuePayouts } from '../services/payouts.ts';
import { runReconciliation } from '../services/reconcile.ts';
import { retryRefund } from '../services/refunds.ts';
import { ApiError, paginated, parsePagination } from '../utils/http.ts';
import { logger } from '../utils/logger.ts';

export const connectSchema = z.object({ currentPassword: z.string().optional() });
export const replaceSchema = z.object({ currentPassword: z.string().min(1, 'Enter your account password') });
export const payoutHoldSchema = z
  .object({ action: z.enum(['release', 'hold']), reason: z.string().trim().max(300).optional() })
  .refine((b) => b.action !== 'hold' || (b.reason && b.reason.length >= 3), { message: 'Give a reason for holding payouts', path: ['reason'] });

/* ------------------------------------------------- vendor: Stripe Connect */

/** Changing where an approved store is paid needs the account password (a stolen session alone can't). */
async function assertPassword(req) {
  if (!req.body.currentPassword) throw new ApiError(403, 'Enter your account password to change where payouts go', { code: 'PASSWORD_REQUIRED' });
  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(req.body.currentPassword))) throw new ApiError(403, 'Incorrect password', { code: 'PASSWORD_REQUIRED' });
}

const links = () => {
  const base = `${env.clientUrls[0]}/vendor/payouts`;
  return { refreshUrl: `${base}?stripe=refresh`, returnUrl: `${base}?stripe=return` };
};

/** Pulls the verified account state from Stripe (#9c: payouts only go to accounts Stripe has enabled). */
async function refreshAccount(vendor) {
  if (!vendor.stripe?.accountId || !connectAvailable()) return vendor.stripe;
  const status = await accountStatus(vendor.stripe.accountId);
  const { transfersActive: _t, ...stored } = status;
  await Vendor.updateOne({ _id: vendor._id }, { $set: { stripe: stored } });
  return { ...stored, transfersActive: status.transfersActive };
}

const view = (stripe, vendor) => ({
  available: connectAvailable(),
  connected: Boolean(stripe?.accountId),
  accountId: stripe?.accountId ? `${stripe.accountId.slice(0, 8)}…${stripe.accountId.slice(-4)}` : null,
  detailsSubmitted: Boolean(stripe?.detailsSubmitted),
  payoutsEnabled: Boolean(stripe?.payoutsEnabled),
  transfersActive: stripe?.transfersActive,
  payoutHold: vendor.payoutHold?.active ? { reason: vendor.payoutHold.reason, since: vendor.payoutHold.since } : null,
});

export async function stripeStatus(req, res) {
  res.json(view(await refreshAccount(req.vendor), req.vendor));
}

/**
 * Starts (or finishes) Stripe onboarding. Creating the first account of an approved store counts as a
 * payout destination change, so it needs the password.
 */
export async function startOnboarding(req, res) {
  if (!connectAvailable()) throw new ApiError(503, 'Stripe is not configured on this server; payouts are settled manually');
  const vendor = req.vendor;
  if (!vendor.stripe?.accountId) {
    if (vendor.status === 'approved') await assertPassword(req);
    const accountId = await createConnectAccount({ vendorId: vendor._id, email: vendor.email || req.user.email, storeName: vendor.storeName });
    vendor.stripe = { accountId };
    vendor.payoutChanges.push({ fields: ['stripeAccount'], by: req.user._id, ip: req.ip });
    await vendor.save();
    await freezePayoutsIfPending(vendor, 'Payout account connected while payouts were waiting');
  }
  res.json({ url: await onboardingLink(vendor.stripe.accountId, links()) });
}

/** Replaces the connected account (password required; waiting payouts are frozen until an admin confirms). */
export async function replaceAccount(req, res) {
  if (!connectAvailable()) throw new ApiError(503, 'Stripe is not configured on this server');
  await assertPassword(req);
  const vendor = req.vendor;
  const previous = vendor.stripe?.accountId;
  const accountId = await createConnectAccount({ vendorId: vendor._id, email: vendor.email || req.user.email, storeName: vendor.storeName });
  vendor.stripe = { accountId };
  vendor.payoutChanges.push({ fields: ['stripeAccount'], by: req.user._id, ip: req.ip });
  await vendor.save();
  const frozen = await freezePayoutsIfPending(vendor, 'Payout account replaced');
  logger.warn(`Store ${vendor.storeName} replaced its Stripe account ${previous || '(none)'} -> ${accountId}`);
  res.json({ url: await onboardingLink(accountId, links()), payoutsFrozen: frozen });
}

/** One-time link to the vendor's Stripe Express dashboard (balance, payouts, bank account). */
export async function stripeDashboard(req, res) {
  if (!req.vendor.stripe?.detailsSubmitted) throw new ApiError(400, 'Finish Stripe onboarding first');
  res.json({ url: await dashboardLink(req.vendor.stripe.accountId) });
}

/* ------------------------------------------------------------------ admin */

/** Refunds by status (default: failed), newest first, with their order number. */
export async function listRefunds(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20 });
  const status = REFUND_STATUSES.includes(req.query.status) ? req.query.status : 'failed';
  const filter = { status };
  const [items, total] = await Promise.all([
    Refund.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate('order', 'orderNumber customer').lean(),
    Refund.countDocuments(filter),
  ]);
  res.json(paginated(items, total, page, limit));
}

export async function retryRefundById(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid refund id');
  res.json({ refund: await retryRefund(req.params.id) });
}

export async function reconcile(_req, res) {
  res.json({ report: await runReconciliation() });
}

export async function releasePayouts(_req, res) {
  res.json({ result: await releaseDuePayouts() });
}

/** #9(d): the admin confirms a payout destination change (release) or freezes payouts (hold). */
export async function setPayoutHold(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid vendor id');
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) throw new ApiError(404, 'Store not found');
  vendor.payoutHold =
    req.body.action === 'release'
      ? { active: false, reason: vendor.payoutHold?.reason, since: vendor.payoutHold?.since, clearedBy: req.user._id, clearedAt: new Date() }
      : { active: true, reason: req.body.reason, since: new Date() };
  await vendor.save();
  res.json({ payoutHold: vendor.payoutHold });
}
