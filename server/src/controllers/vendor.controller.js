import mongoose from 'mongoose';
import { z } from 'zod';
import { STORE_NAME_COLLATION, Vendor } from '../models/Vendor.js';
import { User } from '../models/User.js';
import { Product, PRODUCT_LIMITS } from '../models/Product.js';
import { Category } from '../models/Category.js';
import { Order } from '../models/Order.js';
import { invalidateUser } from '../services/session.js';
import { indexProducts } from '../services/search.js';
import { invalidateCatalog, invalidateProducts } from '../services/catalog.js';
import { deleteReplaced } from '../services/storage.js';
import { transitionPackage, withPackageLock } from '../services/orders.js';
import { logger } from '../utils/logger.js';
import { freezePayoutsIfPending, RETURN_WINDOW_DAYS } from '../services/payouts.js';
import { ApiError, escapeRegex, paginated, parsePagination, round2 } from '../utils/http.js';
import { address, cancelReason, email, gstin, phone } from '../utils/validators.js';
import { bucketFormat, fillSeries, percentChange, rangeStart, TIMEZONE } from '../utils/analytics.js';

const optionalUrl = z.string().url().or(z.literal('')).optional();

const bankSchema = z.object({
  accountHolder: z.string().trim().min(2, 'Account holder name is required'),
  accountNumber: z.string().trim().regex(/^\d{9,18}$/, 'Account number must be 9–18 digits'),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code (e.g. HDFC0001234)'),
});

export const onboardSchema = z.object({
  storeName: z.string().trim().min(3, 'Store name must be at least 3 characters').max(60),
  tagline: z.string().trim().max(120).optional().default(''),
  description: z.string().trim().max(2000).optional().default(''),
  email,
  phone,
  gstin: gstin.or(z.literal('')).optional(),
  logo: optionalUrl,
  banner: optionalUrl,
  address,
  /** Bank details for manual settlement; vendors on Stripe Connect keep theirs in Stripe. */
  bank: bankSchema,
});

export const storeUpdateSchema = onboardSchema
  .omit({ bank: true })
  .partial()
  .extend({ bank: bankSchema.optional(), currentPassword: z.string().optional() });

/**
 * On an approved store, changing where payouts go needs the account password, and every change is
 * recorded. A stolen session token alone can't redirect payouts. (The Stripe account is changed through
 * /vendor/stripe/*, with the same rules.)
 */
async function guardPayoutChange(req, vendor) {
  const fields = [];
  if (req.body.bank) fields.push('bank');
  if (!fields.length || vendor.status !== 'approved') return fields;

  if (!req.body.currentPassword) {
    throw new ApiError(403, 'Enter your account password to change payout details', { code: 'PASSWORD_REQUIRED', fields });
  }
  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(req.body.currentPassword))) throw new ApiError(403, 'Incorrect password', { code: 'PASSWORD_REQUIRED', fields });
  return fields;
}

const maskBank = ({ accountHolder, accountNumber, ifsc }) => ({
  accountHolder,
  ifsc,
  accountNumberMasked: `${'•'.repeat(Math.max(0, accountNumber.length - 4))}${accountNumber.slice(-4)}`,
});

/* ------------------------------------------------------------ onboarding */

/** Store names and phones are unique across vendors; check up front for a friendly message. */
async function assertStoreAvailable({ storeName, phone: storePhone }, exceptId) {
  const notSelf = exceptId ? { _id: { $ne: exceptId } } : {};
  if (storeName && (await Vendor.findOne({ storeName, ...notSelf }).collation(STORE_NAME_COLLATION).select('_id').lean())) {
    throw new ApiError(409, 'A store with this name already exists. Please choose another name.');
  }
  if (storePhone && (await Vendor.exists({ phone: storePhone, ...notSelf }))) {
    throw new ApiError(409, 'This phone number is already used by another store');
  }
}

export async function onboard(req, res) {
  if (req.user.role === 'admin') throw new ApiError(400, 'Admins cannot open a store');
  if (await Vendor.exists({ user: req.user._id })) throw new ApiError(409, 'You already have a store');
  const { bank, ...rest } = req.body;
  await assertStoreAvailable(rest);
  const vendor = await Vendor.create({
    ...rest,
    user: req.user._id,
    bank: maskBank(bank),
    status: 'pending',
    statusHistory: [{ status: 'pending', reason: 'Application submitted', by: req.user._id }],
  });
  if (req.user.role !== 'vendor') {
    await User.updateOne({ _id: req.user._id }, { role: 'vendor' });
    await invalidateUser(req.user._id);
  }
  res.status(201).json({ vendor });
}

export async function myStore(req, res) {
  res.json({ vendor: req.vendor });
}

export async function updateStore(req, res) {
  const vendor = req.vendor;
  const payoutFields = await guardPayoutChange(req, vendor);
  const { bank, currentPassword: _password, ...rest } = req.body;
  const renamed = rest.storeName && rest.storeName !== vendor.storeName;
  const pictures = () => [vendor.logo, vendor.banner];
  const before = pictures();
  await assertStoreAvailable(rest, vendor._id);
  Object.assign(vendor, rest);
  if (bank) vendor.bank = maskBank(bank);
  if (payoutFields.length) {
    vendor.payoutChanges.push({ fields: payoutFields, by: req.user._id, ip: req.ip });
    logger.warn(`Payout details changed for store ${vendor.storeName} (${payoutFields.join(', ')}) by user ${req.user._id}`);
  }
  // Money still waiting to be paid out stays frozen until an admin confirms the new destination.
  if (payoutFields.length && vendor.status === 'approved') await freezePayoutsIfPending(vendor, 'Bank details changed');
  if (vendor.status === 'rejected') {
    vendor.setStatus('pending', { reason: 'Resubmitted after rejection', by: req.user._id });
    vendor.rejectionReason = undefined;
  }
  await vendor.save();
  deleteReplaced(before, pictures(), req.user._id);
  await invalidateCatalog();
  if (renamed) {
    const ids = await Product.find({ vendor: vendor._id }).distinct('_id');
    indexProducts(ids);
  }
  res.json({ vendor });
}

/* ------------------------------------------------------------- dashboard */

export async function dashboard(req, res) {
  const vendorId = req.vendor._id;
  const days = 30;
  const since = rangeStart(days);
  const previousSince = rangeStart(days * 2);
  const live = { 'packages.status': { $nin: ['cancelled', 'pending'] } };

  const [agg] = await Order.aggregate([
    { $match: { 'packages.vendor': vendorId, 'payment.status': { $in: ['paid', 'refunded'] } } },
    { $unwind: '$packages' },
    { $match: { 'packages.vendor': vendorId } },
    {
      $facet: {
        totals: [
          { $match: live },
          {
            $group: {
              _id: null,
              revenue: { $sum: '$packages.total' },
              earnings: { $sum: '$packages.vendorEarning' },
              commission: { $sum: '$packages.commission' },
              orders: { $sum: 1 },
              units: { $sum: { $sum: '$packages.items.quantity' } },
            },
          },
        ],
        periods: [
          { $match: { ...live, createdAt: { $gte: previousSince } } },
          {
            $group: {
              _id: { $cond: [{ $gte: ['$createdAt', since] }, 'current', 'previous'] },
              revenue: { $sum: '$packages.total' },
              earnings: { $sum: '$packages.vendorEarning' },
              orders: { $sum: 1 },
            },
          },
        ],
        series: [
          { $match: { ...live, createdAt: { $gte: since } } },
          {
            $group: {
              _id: { $dateToString: { format: bucketFormat(days), date: '$createdAt', timezone: TIMEZONE } },
              revenue: { $sum: '$packages.total' },
              earnings: { $sum: '$packages.vendorEarning' },
              orders: { $sum: 1 },
            },
          },
        ],
        byStatus: [{ $group: { _id: '$packages.status', count: { $sum: 1 } } }],
        payouts: [{ $match: live }, { $group: { _id: '$packages.payout.status', amount: { $sum: '$packages.vendorEarning' } } }],
        topProducts: [
          { $match: live },
          { $unwind: '$packages.items' },
          {
            $group: {
              _id: '$packages.items.product',
              title: { $first: '$packages.items.title' },
              image: { $first: '$packages.items.image' },
              units: { $sum: '$packages.items.quantity' },
              revenue: { $sum: '$packages.items.total' },
            },
          },
          { $sort: { revenue: -1 } },
          { $limit: 5 },
        ],
        recent: [
          { $sort: { createdAt: -1 } },
          { $limit: 6 },
          {
            $project: {
              orderNumber: 1,
              createdAt: 1,
              customer: '$shippingAddress.fullName',
              status: '$packages.status',
              total: '$packages.total',
              items: { $size: '$packages.items' },
            },
          },
        ],
      },
    },
  ]);

  const [productCount, outOfStock, lowStock] = await Promise.all([
    Product.countDocuments({ vendor: vendorId, deletedAt: null }),
    Product.countDocuments({ vendor: vendorId, deletedAt: null, stock: 0 }),
    Product.find({ vendor: vendorId, deletedAt: null, stock: { $gt: 0, $lte: 10 } }).sort({ stock: 1 }).limit(6).select('title thumbnail stock').lean(),
  ]);

  const period = (id) => agg.periods.find((p) => p._id === id) || { revenue: 0, earnings: 0, orders: 0 };
  const current = period('current');
  const previous = period('previous');
  const totals = agg.totals[0] || { revenue: 0, earnings: 0, commission: 0, orders: 0, units: 0 };
  const payouts = Object.fromEntries(agg.payouts.map((p) => [p._id || 'pending', round2(p.amount)]));

  res.json({
    store: { _id: req.vendor._id, storeName: req.vendor.storeName, status: req.vendor.status },
    kpis: {
      revenue: { value: round2(current.revenue), change: percentChange(current.revenue, previous.revenue) },
      earnings: { value: round2(current.earnings), change: percentChange(current.earnings, previous.earnings) },
      orders: { value: current.orders, change: percentChange(current.orders, previous.orders) },
      products: { value: productCount, outOfStock },
    },
    lifetime: { ...totals, revenue: round2(totals.revenue), earnings: round2(totals.earnings), commission: round2(totals.commission) },
    payouts: { onHold: payouts.on_hold || 0, released: payouts.released || 0, pending: payouts.pending || 0 },
    series: fillSeries(agg.series, days, ['revenue', 'earnings', 'orders']),
    byStatus: agg.byStatus.map((s) => ({ status: s._id, count: s.count })),
    topProducts: agg.topProducts,
    recentOrders: agg.recent,
    lowStock,
  });
}

/* -------------------------------------------------------------- products */

const productBase = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(PRODUCT_LIMITS.title, `Title can be up to ${PRODUCT_LIMITS.title} characters`),
  description: z.string().trim().max(PRODUCT_LIMITS.description, `Description can be up to ${PRODUCT_LIMITS.description} characters`).default(''),
  brand: z.string().trim().max(60).default('Generic'),
  category: z.string().regex(/^[a-f\d]{24}$/i, 'Choose a category'),
  price: z.coerce.number().positive('Price must be greater than 0').max(10000000).transform(round2),
  mrp: z.coerce.number().min(0).transform(round2).optional(),
  stock: z.coerce.number().int('Stock must be a whole number').min(0).max(100000),
  sku: z.string().trim().max(60).optional().default(''),
  images: z
    .array(z.object({ url: z.string().url() }))
    .min(1, 'Add at least one image')
    .max(PRODUCT_LIMITS.images, `Up to ${PRODUCT_LIMITS.images} images allowed`),
  tags: z.array(z.string().trim().min(1).max(30)).max(PRODUCT_LIMITS.tags, `Up to ${PRODUCT_LIMITS.tags} tags allowed`).default([]),
  specs: z
    .array(z.object({ label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(200) }))
    .max(PRODUCT_LIMITS.specs, `Up to ${PRODUCT_LIMITS.specs} specs allowed`)
    .default([]),
  isActive: z.boolean().default(true),
});

const mrpRule = [(d) => !d.mrp || d.price === undefined || d.mrp >= d.price, { message: 'MRP cannot be lower than the selling price', path: ['mrp'] }];
export const productCreateSchema = productBase.refine(...mrpRule);
export const productUpdateSchema = productBase
  .partial()
  .extend({
    /** editVersion the form was loaded with; a newer one on the server means someone else saved meanwhile. */
    editVersion: z.coerce.number().int().min(0).optional(),
    /** Stock the form was loaded with; required to change stock, so sales made meanwhile aren't overwritten. */
    stockBase: z.coerce.number().int().min(0).optional(),
  })
  .refine(...mrpRule);

async function ownProduct(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid product id');
  const product = await Product.findOne({ _id: req.params.id, vendor: req.vendor._id, deletedAt: null });
  if (!product) throw new ApiError(404, 'Product not found');
  return product;
}

async function assertSkuFree(vendorId, sku, exceptId) {
  if (sku && (await Product.exists({ vendor: vendorId, sku, deletedAt: null, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }))) {
    throw new ApiError(409, `You already have a product with SKU ${sku}`);
  }
}

/** New or moved products must go into a category shoppers can see. */
async function assertCategory(id) {
  if (id && !(await Category.exists({ _id: id, isActive: true }))) throw new ApiError(400, 'Unknown category');
}

/**
 * After a save: if the category was deleted or switched off while the product was being saved, hide the
 * product like the category deletion did for the others (it is listed again when the seller picks a category).
 */
async function hideIfCategoryGone(product) {
  if (await Category.exists({ _id: product.category, isActive: true })) return;
  await Product.updateOne({ _id: product._id }, { $set: { categoryHidden: true } });
  product.categoryHidden = true;
}

export async function listMyProducts(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 12 });
  const filter = { vendor: req.vendor._id, deletedAt: null };
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    filter.$or = [{ title: rx }, { sku: rx }, { brand: rx }];
  }
  if (mongoose.isValidObjectId(req.query.category)) filter.category = req.query.category;
  const statusFilters = {
    active: { isActive: true },
    inactive: { isActive: false },
    out_of_stock: { stock: 0 },
    low_stock: { stock: { $gt: 0, $lte: 10 } },
  };
  Object.assign(filter, statusFilters[req.query.status] || {});
  const sorts = {
    newest: { createdAt: -1 },
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    stock: { stock: 1 },
    best_selling: { sold: -1 },
  };
  const [items, total] = await Promise.all([
    Product.find(filter).sort(sorts[req.query.sort] || sorts.newest).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);
  res.json(paginated(items, total, page, limit));
}

export async function getMyProduct(req, res) {
  res.json({ product: await ownProduct(req) });
}

export async function createProduct(req, res) {
  await assertCategory(req.body.category);
  await assertSkuFree(req.vendor._id, req.body.sku);
  const product = await Product.create({
    ...req.body,
    vendor: req.vendor._id,
  });
  await hideIfCategoryGone(product);
  await invalidateCatalog();
  await indexProducts([product._id]);
  res.status(201).json({ product });
}

export async function updateProduct(req, res) {
  const product = await ownProduct(req);
  await assertCategory(req.body.category);
  await assertSkuFree(req.vendor._id, req.body.sku, product._id);
  const price = req.body.price ?? product.price;
  const mrp = req.body.mrp ?? product.mrp;
  if (mrp && mrp < price) throw new ApiError(400, 'MRP cannot be lower than the selling price');

  const { editVersion, stockBase, stock, ...changes } = req.body;
  // Missing editVersion on older products counts as 0.
  const versionNow = { $in: product.editVersion ? [product.editVersion] : [0, null] };
  if (editVersion !== undefined && editVersion !== (product.editVersion || 0)) {
    throw new ApiError(409, 'This product was changed elsewhere (another tab or person) since you opened it. The latest version has been loaded.', {
      code: 'PRODUCT_CHANGED',
    });
  }
  // Claim this edit: a concurrent save that read the same version now fails the check above or this update.
  const claimed = await Product.updateOne(editVersion !== undefined ? { _id: product._id, editVersion: versionNow } : { _id: product._id }, { $inc: { editVersion: 1 } });
  if (editVersion !== undefined && !claimed.modifiedCount) {
    throw new ApiError(409, 'This product was changed elsewhere since you opened it. The latest version has been loaded.', { code: 'PRODUCT_CHANGED' });
  }
  if (stock !== undefined) {
    // Stock is written only if it is still what the seller saw: orders placed meanwhile change it, and an
    // absolute write from an old form would sell those units again.
    const base = stockBase ?? product.stock;
    const written = await Product.updateOne({ _id: product._id, stock: base }, { $set: { stock } });
    if (!written.matchedCount) {
      const current = (await Product.findById(product._id).select('stock').lean())?.stock;
      throw new ApiError(409, `Stock changed from ${base} to ${current} since you opened this form (orders came in). Check the stock and save again.`, {
        code: 'STOCK_CHANGED',
        stock: current,
      });
    }
  }
  const fresh = await Product.findById(product._id);
  product.set({ editVersion: fresh.editVersion, stock: fresh.stock });

  const imageUrls = () => product.images.map((img) => img.url);
  const before = imageUrls();
  Object.assign(product, changes);
  // Moving out of a hidden or deleted category lists the product again (assertCategory checked the new one).
  if (req.body.category) product.categoryHidden = false;
  await product.save();
  if (req.body.category) await hideIfCategoryGone(product);
  deleteReplaced(before, imageUrls(), req.user._id);
  await invalidateProducts([product]);
  await invalidateCatalog();
  await indexProducts([product._id]);
  res.json({ product });
}

/** Soft delete: images, reviews and sales history are kept; admins still see the product as deleted. */
export async function deleteProduct(req, res) {
  const product = await ownProduct(req);
  product.deletedAt = new Date();
  product.deletedBy = req.user._id;
  await product.save();
  await invalidateProducts([product]);
  await invalidateCatalog();
  // Kept in the index as inactive (like hidden products), so its document count stays equal to MongoDB's.
  await indexProducts([product._id]);
  res.json({ message: 'Product deleted' });
}

/* ---------------------------------------------------------------- orders */

export async function listOrders(req, res) {
  const vendorId = req.vendor._id;
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 10 });
  const base = [
    { $match: { 'packages.vendor': vendorId, 'payment.status': { $in: ['paid', 'refunded'] } } },
    { $unwind: '$packages' },
    { $match: { 'packages.vendor': vendorId } },
  ];
  const match = {};
  if (req.query.status) match['packages.status'] = req.query.status;
  if (req.query.q) match.orderNumber = new RegExp(escapeRegex(req.query.q), 'i');

  const [result] = await Order.aggregate([
    ...base,
    {
      $facet: {
        items: [
          { $match: match },
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
          { $project: { orderNumber: 1, createdAt: 1, shippingAddress: 1, 'payment.status': 1, package: '$packages' } },
        ],
        total: [{ $match: match }, { $count: 'n' }],
        counts: [{ $group: { _id: '$packages.status', count: { $sum: 1 } } }],
      },
    },
  ]);
  res.json({
    ...paginated(result.items, result.total[0]?.n || 0, page, limit),
    counts: Object.fromEntries(result.counts.map((c) => [c._id, c.count])),
  });
}

export const statusSchema = z
  .object({
    status: z.enum(['packed', 'shipped', 'delivered', 'cancelled']),
    trackingId: z.string().trim().max(40).optional(),
    note: z.string().trim().max(200).optional(),
    reasonCode: z.string().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.status !== 'cancelled') return;
    const r = cancelReason('vendor').safeParse(b);
    if (!r.success) r.error.issues.forEach((issue) => ctx.addIssue(issue));
  });

export async function updateOrderStatus(req, res) {
  if (!mongoose.isValidObjectId(req.params.orderId)) throw new ApiError(400, 'Invalid order id');
  // Checkout creates exactly one package per vendor, so the order id identifies this vendor's package.
  const probe = await Order.findOne({ _id: req.params.orderId, 'packages.vendor': req.vendor._id }).select('packages._id packages.vendor').lean();
  if (!probe) throw new ApiError(404, 'Order not found');
  const packageId = probe.packages.find((p) => String(p.vendor) === String(req.vendor._id))._id;
  const { order, pkg } = await withPackageLock(packageId, async () => {
    // Re-read inside the lock so the transition check sees the latest status.
    const fresh = await Order.findById(req.params.orderId);
    const own = fresh.packages.id(packageId);
    const { status, note, trackingId, reasonCode } = req.body;
    const cancellation = status === 'cancelled' ? { by: 'vendor', actorId: req.user._id, reasonCode, note } : undefined;
    await transitionPackage(fresh, own, status, { note: status === 'cancelled' ? `Cancelled by seller${note ? `: ${note}` : ''}` : note, trackingId, cancellation });
    await fresh.save();
    return { order: fresh, pkg: own };
  });
  res.json({ order: { _id: order._id, orderNumber: order.orderNumber, status: order.status }, package: pkg });
}

/* --------------------------------------------------------------- payouts */

export async function payouts(req, res) {
  const vendorId = req.vendor._id;
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 15 });
  const match = { 'packages.vendor': vendorId };
  if (req.query.status) match['packages.payout.status'] = req.query.status;

  const [result] = await Order.aggregate([
    { $match: { 'packages.vendor': vendorId, 'payment.status': { $in: ['paid', 'refunded'] } } },
    { $unwind: '$packages' },
    { $match: { 'packages.vendor': vendorId } },
    {
      $facet: {
        items: [
          { $match: match },
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              orderNumber: 1,
              createdAt: 1,
              packageStatus: '$packages.status',
              total: '$packages.total',
              commissionRate: '$packages.commissionRate',
              commission: '$packages.commission',
              vendorEarning: '$packages.vendorEarning',
              payout: '$packages.payout',
            },
          },
        ],
        total: [{ $match: match }, { $count: 'n' }],
        summary: [
          {
            $group: {
              _id: '$packages.payout.status',
              amount: { $sum: '$packages.vendorEarning' },
              commission: { $sum: '$packages.commission' },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);
  const summary = Object.fromEntries(result.summary.map((s) => [s._id || 'pending', { amount: round2(s.amount), commission: round2(s.commission), count: s.count }]));
  res.json({
    ...paginated(result.items, result.total[0]?.n || 0, page, limit),
    summary,
    stripe: { connected: Boolean(req.vendor.stripe?.accountId), payoutsEnabled: Boolean(req.vendor.stripe?.payoutsEnabled) },
    payoutHold: req.vendor.payoutHold?.active ? { reason: req.vendor.payoutHold.reason, since: req.vendor.payoutHold.since } : null,
    returnWindowDays: RETURN_WINDOW_DAYS,
    commissionRate: req.vendor.commissionRate,
  });
}
