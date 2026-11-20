import { z } from 'zod';
import { Coupon } from '../models/Coupon.ts';
import { CouponRedemption } from '../models/CouponRedemption.ts';
import { ApiError, paginated, parsePagination } from '../utils/http.ts';

/** 0 or empty means "no limit" in the form; stored as null. */
const optionalLimit = z.preprocess((v) => (v === '' || v === 0 || v === '0' || v == null ? null : v), z.coerce.number().int().min(1).nullable());

const couponBase = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,20}$/, 'Use 3–20 letters, numbers, - or _'),
  description: z.string().trim().max(160).default(''),
  type: z.enum(['percent', 'flat']),
  value: z.coerce.number().positive('Value must be greater than 0'),
  minOrder: z.coerce.number().min(0).default(0),
  maxDiscount: optionalLimit.default(null),
  startsAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  usageLimit: optionalLimit.default(null),
  perUserLimit: z.coerce.number().int().min(1).default(1),
  isActive: z.boolean().default(true),
  isPublic: z.boolean().optional(),
});

// The rules themselves live in the Coupon schema; flat coupons simply drop maxDiscount.
const dropCapForFlat = (c) => (c.type === 'flat' ? { ...c, maxDiscount: null } : c);
export const couponCreateSchema = couponBase.transform(dropCapForFlat);
export const couponUpdateSchema = couponBase.partial().transform(dropCapForFlat);

/**
 * Coupon CRUD shared by admins (platform-wide coupons, vendor = null)
 * and vendors (coupons that only discount their own products).
 */
const scopeOf = (req) => (req.vendor ? req.vendor._id : null);

/** Only admins decide whether a coupon is listed publicly. */
function assertCanSetVisibility(req) {
  if (req.vendor && req.body.isPublic !== undefined) throw new ApiError(403, 'Only admins can change coupon visibility');
}

export async function listCoupons(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20 });
  const filter = req.vendor ? { vendor: req.vendor._id } : req.query.scope === 'all' ? {} : { vendor: null };
  const [items, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('vendor', 'storeName').lean(),
    Coupon.countDocuments(filter),
  ]);
  res.json(paginated(items, total, page, limit));
}

export async function createCoupon(req, res) {
  assertCanSetVisibility(req);
  if (await Coupon.exists({ code: req.body.code })) throw new ApiError(409, `Coupon ${req.body.code} already exists`);
  const coupon = await Coupon.create({ ...req.body, vendor: scopeOf(req) });
  res.status(201).json({ coupon });
}

async function ownCoupon(req) {
  const filter: Record<string, any> = { _id: req.params.id };
  if (req.vendor) filter.vendor = req.vendor._id;
  const coupon = await Coupon.findOne(filter);
  if (!coupon) throw new ApiError(404, 'Coupon not found');
  return coupon;
}

export async function updateCoupon(req, res) {
  assertCanSetVisibility(req);
  const coupon = await ownCoupon(req);
  if (req.body.code && req.body.code !== coupon.code && (await Coupon.exists({ code: req.body.code }))) {
    throw new ApiError(409, `Coupon ${req.body.code} already exists`);
  }
  Object.assign(coupon, req.body);
  await coupon.save();
  res.json({ coupon });
}

/** Only never-used coupons can be deleted; used ones keep their history and can be switched off instead. */
export async function deleteCoupon(req, res) {
  const coupon = await ownCoupon(req);
  if (coupon.usedCount > 0 || (await CouponRedemption.exists({ coupon: coupon._id }))) {
    throw new ApiError(409, 'This coupon has been used, so it can only be deactivated');
  }
  await coupon.deleteOne();
  res.json({ message: 'Coupon deleted' });
}
