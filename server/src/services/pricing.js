import { Settings } from '../models/Settings.js';
import { Coupon } from '../models/Coupon.js';
import { Vendor } from '../models/Vendor.js';
import { liveRedemptions } from './coupons.js';
import { cache } from './cache.js';
import { ApiError, round2 } from '../utils/http.js';

/** Platform settings (read-only here: a cache miss is a plain read; the defaults apply until an admin saves). */
export async function getSettings() {
  return cache.remember('settings', 300, async () => {
    const doc = await Settings.findOne({ key: 'platform' }).select('-history').lean();
    return doc || new Settings().toObject({ versionKey: false });
  });
}

export const shippingFor = (amount, settings) =>
  amount <= 0 || amount >= settings.freeShippingThreshold ? 0 : settings.shippingFee;

const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/**
 * Validates a coupon against cart lines ({ vendorId, lineTotal }) and returns the discount.
 * Vendor coupons only discount that vendor's items; platform coupons discount the whole cart.
 */
export async function evaluateCoupon(code, lines, userId) {
  const coupon = await Coupon.findOne({ code: String(code || '').trim().toUpperCase() });
  if (!coupon || !coupon.isActive) throw new ApiError(404, 'That coupon code is not valid');
  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) throw new ApiError(400, 'This coupon is not active yet');
  if (coupon.expiresAt && coupon.expiresAt < now) throw new ApiError(400, 'This coupon has expired');
  // Early, friendly checks; the binding ones are atomic in holdCoupon() at checkout.
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) throw new ApiError(400, 'This coupon has reached its usage limit');
  if ((await liveRedemptions(coupon._id, userId)).length >= coupon.perUserLimit) throw new ApiError(400, 'You have already used this coupon');

  const eligible = coupon.vendor ? lines.filter((l) => String(l.vendorId) === String(coupon.vendor)) : lines;
  if (!eligible.length) {
    const vendor = await Vendor.findById(coupon.vendor).select('storeName').lean();
    throw new ApiError(400, `This coupon only works on products from ${vendor?.storeName || 'a specific store'}`);
  }
  const eligibleSubtotal = eligible.reduce((sum, l) => sum + l.lineTotal, 0);
  if (eligibleSubtotal < coupon.minOrder) {
    throw new ApiError(400, `Add ${inr(coupon.minOrder - eligibleSubtotal)} more of eligible items to use this coupon`);
  }

  let discount = coupon.type === 'percent' ? (eligibleSubtotal * coupon.value) / 100 : coupon.value;
  if (coupon.type === 'percent' && coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
  discount = Math.min(Math.round(discount), eligibleSubtotal);

  return {
    coupon,
    discount,
    vendorId: coupon.vendor ? String(coupon.vendor) : null,
    summary: { code: coupon.code, description: coupon.description, discount, type: coupon.type, value: coupon.value },
  };
}

/**
 * Splits a discount across packages in proportion to their subtotal (the last package absorbs rounding),
 * so package totals always add up to the order total.
 */
export function distributeDiscount(packages, discount, vendorId) {
  const targets = vendorId ? packages.filter((p) => String(p.vendor) === vendorId) : packages;
  const base = targets.reduce((sum, p) => sum + p.subtotal, 0);
  let remaining = discount;
  targets.forEach((pkg, index) => {
    const share = index === targets.length - 1 ? remaining : round2((discount * pkg.subtotal) / base);
    pkg.discount = Math.min(share, pkg.subtotal);
    remaining = round2(remaining - pkg.discount);
  });
  return packages;
}

/** Applies commission to each package: platform keeps `commission`, vendor receives `vendorEarning`. */
export function applyCommission(pkg, rate) {
  pkg.total = round2(pkg.subtotal - (pkg.discount || 0));
  pkg.commissionRate = rate;
  pkg.commission = round2((pkg.total * rate) / 100);
  pkg.vendorEarning = round2(pkg.total - pkg.commission);
  return pkg;
}
