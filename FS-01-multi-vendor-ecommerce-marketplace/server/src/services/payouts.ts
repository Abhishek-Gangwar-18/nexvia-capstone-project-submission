import { env } from '../config/env.ts';
import { Order } from '../models/Order.ts';
import { Payment } from '../models/Payment.ts';
import { OPEN_RETURN_STATUSES, Return } from '../models/Return.ts';
import { Vendor } from '../models/Vendor.ts';
import { withPackageLock } from './locks.ts';
import { connectAvailable, createTransfer, gatewayError, reverseTransfer } from './payment.ts';
import { round2 } from '../utils/http.ts';
import { logger } from '../utils/logger.ts';

const DAY = 24 * 60 * 60 * 1000;
export const RETURN_WINDOW_DAYS = env.payments.returnWindowDays;
/** A "releasing" claim older than this is considered abandoned (crash mid-transfer) and retried. */
const STALE_CLAIM_MS = 15 * 60 * 1000;

/** Called when a package is delivered: the vendor is paid once the return window has passed. */
export function scheduleRelease(pkg, deliveredAt) {
  pkg.payout.releaseAfter = new Date(deliveredAt.getTime() + RETURN_WINDOW_DAYS * DAY);
}

/** Vendor share still owed for a package: its earning minus the vendor share of refunded returns. */
export const payoutAmount = (pkg) => round2(Math.max(0, pkg.vendorEarning - (pkg.returned?.vendorShare || 0)));

const setPayout = (orderId, packageId, fields, extra: Record<string, any> = {}) =>
  Order.updateOne(
    { _id: orderId, 'packages._id': packageId },
    { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`packages.$.payout.${k}`, v])), ...extra },
  );

/**
 * Pays one package out, exactly once: the package is claimed (on_hold -> releasing) with a conditional
 * update, so two job runs can never both transfer. Anything that blocks the release puts it back on hold
 * with the reason; the next run tries again.
 */
export async function releasePackagePayout(orderId, packageId) {
  const now = new Date();
  const backOnHold = async (error) => {
    await setPayout(orderId, packageId, { status: 'on_hold', error });
    return 'held';
  };

  // The claim and the open-return check share the package lock with return requests, so a return can't be
  // saved in between; once the package is "releasing", new return requests are refused.
  let claimed;
  try {
    claimed = await withPackageLock(packageId, async () => {
      const doc = await Order.findOneAndUpdate(
        { _id: orderId, packages: { $elemMatch: { _id: packageId, status: 'delivered', 'payout.status': 'on_hold', 'payout.releaseAfter': { $lte: now } } } },
        { $set: { 'packages.$.payout.status': 'releasing', 'packages.$.payout.claimedAt': now } },
        { new: true },
      );
      if (doc && (await Return.exists({ package: packageId, status: { $in: OPEN_RETURN_STATUSES } }))) {
        return backOnHold('Waiting for an open return to be resolved');
      }
      return doc;
    });
  } catch (err) {
    // 409: a return request or status update holds the package. 503: the lock store is down. Next run.
    if (err.status === 409 || err.status === 503) return 'skipped';
    throw err;
  }
  if (!claimed) return 'skipped';
  if (claimed === 'held') return 'held';
  const pkg = claimed.packages.id(packageId);

  const vendor = await Vendor.findById(pkg.vendor).select('stripe payoutHold storeName').lean();
  if (vendor?.payoutHold?.active) return backOnHold(`Payouts on hold: ${vendor.payoutHold.reason}`);

  const amount = payoutAmount(pkg);
  const viaStripe = claimed.payment.provider === 'stripe' && connectAvailable() && vendor?.stripe?.accountId && vendor.stripe.payoutsEnabled;
  if (!viaStripe || amount <= 0) {
    // No connected account (or nothing left to pay): the platform settles it outside Stripe from the ledger.
    await setPayout(orderId, packageId, { status: 'released', mode: 'manual', amount, releasedAt: now, error: null });
    return 'released';
  }

  const payment = await Payment.findOne({ order: orderId, status: 'succeeded' }).select('chargeId').lean();
  const attempt = (pkg.payout.attempts || 0) + 1;
  try {
    const transfer = await createTransfer({ destination: vendor.stripe.accountId, amount, chargeId: payment?.chargeId, orderNumber: claimed.orderNumber, packageId, attempt });
    await setPayout(orderId, packageId, { status: 'released', mode: 'stripe', transferId: transfer.id, amount, releasedAt: now, error: null, attempts: attempt });
    return 'released';
  } catch (err) {
    const error = gatewayError(err);
    logger.warn(`Payout for ${claimed.orderNumber} / ${pkg.storeName} failed: ${error}`);
    await setPayout(orderId, packageId, { status: 'on_hold', error, attempts: attempt });
    return 'failed';
  }
}

/** Job (hourly): releases every delivered package whose return window has passed. */
export async function releaseDuePayouts() {
  const now = new Date();
  const orders = await Order.find({ packages: { $elemMatch: { status: 'delivered', 'payout.status': 'on_hold', 'payout.releaseAfter': { $lte: now } } } })
    .select('_id packages._id packages.status packages.payout')
    .limit(100)
    .lean();
  const counts = { released: 0, held: 0, failed: 0, skipped: 0 };
  for (const order of orders) {
    for (const pkg of order.packages) {
      if (pkg.status !== 'delivered' || pkg.payout?.status !== 'on_hold' || !(pkg.payout.releaseAfter <= now)) continue;
      counts[await releasePackagePayout(order._id, pkg._id)] += 1;
    }
  }
  if (counts.released || counts.failed) logger.info(`Payouts: ${counts.released} released, ${counts.failed} failed, ${counts.held} on hold`);
  return counts;
}

/** Reconciliation: claims abandoned mid-transfer go back on hold (the transfer lookup prevents a double pay). */
export async function resetStaleClaims() {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
  const res = await Order.updateMany(
    { packages: { $elemMatch: { 'payout.status': 'releasing', 'payout.claimedAt': { $lt: cutoff } } } },
    { $set: { 'packages.$[p].payout.status': 'on_hold' } },
    { arrayFilters: [{ 'p.payout.status': 'releasing', 'p.payout.claimedAt': { $lt: cutoff } }] },
  );
  return res.modifiedCount;
}

/**
 * A package that won't be paid out (cancelled). Nothing has been transferred before release, so this is
 * normally just bookkeeping; a released Stripe transfer is pulled back and only marked reversed on success.
 */
export async function reversePayout(pkg) {
  if (pkg.payout.status === 'released' && pkg.payout.mode === 'stripe' && pkg.payout.transferId) {
    const result = await reverseTransfer(pkg.payout.transferId, pkg.payout.amount ?? pkg.vendorEarning, `reverse:${pkg._id}`);
    if (!result.ok) {
      Object.assign(pkg.payout, { status: 'reversal_failed', reversalError: result.error });
      return false;
    }
  }
  pkg.payout.status = 'reversed';
  return true;
}

/**
 * #9(d): the payout destination changed while money is still waiting to be paid out -> freeze the
 * vendor payouts until an admin confirms the change. Returns true when a hold was placed.
 */
export async function freezePayoutsIfPending(vendor, reason) {
  const waiting = await Order.exists({ packages: { $elemMatch: { vendor: vendor._id, 'payout.status': { $in: ['on_hold', 'releasing'] } } } });
  if (!waiting) return false;
  await Vendor.updateOne({ _id: vendor._id }, { $set: { payoutHold: { active: true, reason, since: new Date() } } });
  logger.warn(`Payouts frozen for ${vendor.storeName || vendor._id}: ${reason}`);
  return true;
}
