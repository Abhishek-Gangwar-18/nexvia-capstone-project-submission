import { z } from 'zod';
import { Coupon } from '../models/Coupon.js';
import { ApiError, paginated, parsePagination } from '../utils/http.js';

const couponBase = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,20}$/, 'Use 3–20 letters, numbers, - or _'),
  description: z.string().trim().max(160).default(''),
  type: z.enum(['percent', 'flat']),
  value: z.coerce.number().positive('Value must be greater than 0'),
  minOrder: z.coerce.number().min(0).default(0),
  maxDiscount: z.coerce.number().min(0).default(0),
  expiresAt: z.coerce.date().nullable().optional(),
  usageLimit: z.coerce.number().int().min(0).default(0),
  perUserLimit: z.coerce.number().int().min(1).default(1),
  isActive: z.boolean().default(true),
});

const percentRule = [(c) => c.type !== 'percent' || !c.value || c.value <= 90, { message: 'A percentage discount cannot exceed 90%', path: ['value'] }];
export const couponCreateSchema = couponBase.refine(...percentRule);
export const couponUpdateSchema = couponBase.partial().refine(...percentRule);

/**
 * Coupon CRUD shared by admins (platform-wide coupons, vendor = null)
 * and vendors (coupons that only discount their own products).
 */
const scopeOf = (req) => (req.vendor ? req.vendor._id : null);

export async function listCoupons(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20 });
  const filter = req.vendor ? { vendor: req.vendor._id } : req.query.scope === 'all' ? {} : { vendor: null };
  const [items, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('vendor', 'storeName').select('-usedBy').lean(),
    Coupon.countDocuments(filter),
  ]);
  res.json(paginated(items, total, page, limit));
}

export async function createCoupon(req, res) {
  if (await Coupon.exists({ code: req.body.code })) throw new ApiError(409, `Coupon ${req.body.code} already exists`);
  const coupon = await Coupon.create({ ...req.body, vendor: scopeOf(req) });
  res.status(201).json({ coupon });
}

async function ownCoupon(req) {
  const filter = { _id: req.params.id };
  if (req.vendor) filter.vendor = req.vendor._id;
  const coupon = await Coupon.findOne(filter);
  if (!coupon) throw new ApiError(404, 'Coupon not found');
  return coupon;
}

export async function updateCoupon(req, res) {
  const coupon = await ownCoupon(req);
  if (req.body.code && req.body.code !== coupon.code && (await Coupon.exists({ code: req.body.code }))) {
    throw new ApiError(409, `Coupon ${req.body.code} already exists`);
  }
  Object.assign(coupon, req.body);
  await coupon.save();
  res.json({ coupon });
}

export async function deleteCoupon(req, res) {
  const coupon = await ownCoupon(req);
  await coupon.deleteOne();
  res.json({ message: 'Coupon deleted' });
}
