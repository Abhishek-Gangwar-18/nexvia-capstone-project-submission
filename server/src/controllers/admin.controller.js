import mongoose from 'mongoose';
import { z } from 'zod';
import { Order } from '../models/Order.js';
import { User } from '../models/User.js';
import { Vendor } from '../models/Vendor.js';
import { Product } from '../models/Product.js';
import { Category } from '../models/Category.js';
import { Settings } from '../models/Settings.js';
import { cache } from '../services/cache.js';
import { getSettings } from '../services/pricing.js';
import { invalidateUser } from '../services/session.js';
import { indexProducts, indexStats, reindexAll, searchEngine } from '../services/search.js';
import { invalidateCatalog, invalidateProducts } from '../services/catalog.js';
import { transitionPackage } from '../services/orders.js';
import { storageDriver } from '../services/storage.js';
import { paymentProvider } from '../services/payment.js';
import { mongoStatus } from '../config/db.js';
import { ApiError, escapeRegex, paginated, parsePagination, round2 } from '../utils/http.js';
import { bucketFormat, fillSeries, percentChange, rangeStart, TIMEZONE } from '../utils/analytics.js';

/* ------------------------------------------------------------- analytics */

export async function analytics(req, res) {
  const days = [7, 30, 90, 365].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
  const since = rangeStart(days);
  const previousSince = rangeStart(days * 2);
  const live = { 'packages.status': { $nin: ['cancelled', 'pending'] } };
  const inRange = { createdAt: { $gte: since } };

  const [agg] = await Order.aggregate([
    { $match: { 'payment.status': { $in: ['paid', 'refunded'] }, createdAt: { $gte: previousSince } } },
    {
      $facet: {
        periods: [
          { $unwind: '$packages' },
          { $match: live },
          {
            $group: {
              _id: { $cond: [{ $gte: ['$createdAt', since] }, 'current', 'previous'] },
              gmv: { $sum: '$packages.total' },
              commission: { $sum: '$packages.commission' },
              orders: { $addToSet: '$_id' },
            },
          },
          { $project: { gmv: 1, commission: 1, orders: { $size: '$orders' } } },
        ],
        series: [
          { $match: inRange },
          { $unwind: '$packages' },
          { $match: live },
          {
            $group: {
              _id: { $dateToString: { format: bucketFormat(days), date: '$createdAt', timezone: TIMEZONE } },
              gmv: { $sum: '$packages.total' },
              commission: { $sum: '$packages.commission' },
              orders: { $addToSet: '$_id' },
            },
          },
          { $project: { gmv: 1, commission: 1, orders: { $size: '$orders' } } },
        ],
        byStatus: [{ $match: inRange }, { $unwind: '$packages' }, { $group: { _id: '$packages.status', count: { $sum: 1 } } }],
        byCategory: [
          { $match: inRange },
          { $unwind: '$packages' },
          { $match: live },
          { $unwind: '$packages.items' },
          { $group: { _id: '$packages.items.category', revenue: { $sum: '$packages.items.total' }, units: { $sum: '$packages.items.quantity' } } },
          { $sort: { revenue: -1 } },
          { $limit: 8 },
        ],
        topProducts: [
          { $match: inRange },
          { $unwind: '$packages' },
          { $match: live },
          { $unwind: '$packages.items' },
          {
            $group: {
              _id: '$packages.items.product',
              title: { $first: '$packages.items.title' },
              image: { $first: '$packages.items.image' },
              slug: { $first: '$packages.items.slug' },
              store: { $first: '$packages.storeName' },
              units: { $sum: '$packages.items.quantity' },
              revenue: { $sum: '$packages.items.total' },
            },
          },
          { $sort: { revenue: -1 } },
          { $limit: 5 },
        ],
        topVendors: [
          { $match: inRange },
          { $unwind: '$packages' },
          { $match: live },
          {
            $group: {
              _id: '$packages.vendor',
              storeName: { $first: '$packages.storeName' },
              gmv: { $sum: '$packages.total' },
              commission: { $sum: '$packages.commission' },
              orders: { $sum: 1 },
            },
          },
          { $sort: { gmv: -1 } },
          { $limit: 5 },
        ],
      },
    },
  ]);

  const [customers, newCustomers, vendors, pendingVendors, products, categories, recentOrders] = await Promise.all([
    User.countDocuments({ role: 'customer' }),
    User.countDocuments({ role: 'customer', createdAt: { $gte: since } }),
    Vendor.countDocuments({ status: 'approved' }),
    Vendor.countDocuments({ status: 'pending' }),
    Product.countDocuments({ isActive: true }),
    Category.find().select('slug name').lean(),
    Order.find({ 'payment.status': { $in: ['paid', 'refunded'] } })
      .sort({ createdAt: -1 })
      .limit(7)
      .populate('customer', 'name email')
      .select('orderNumber status pricing.total createdAt customer packages.storeName')
      .lean(),
  ]);

  const period = (id) => agg.periods.find((p) => p._id === id) || { gmv: 0, commission: 0, orders: 0 };
  const current = period('current');
  const previous = period('previous');
  const aov = (p) => (p.orders ? p.gmv / p.orders : 0);
  const names = new Map(categories.map((c) => [c.slug, c.name]));

  res.json({
    range: days,
    kpis: {
      gmv: { value: round2(current.gmv), change: percentChange(current.gmv, previous.gmv) },
      commission: { value: round2(current.commission), change: percentChange(current.commission, previous.commission) },
      orders: { value: current.orders, change: percentChange(current.orders, previous.orders) },
      aov: { value: round2(aov(current)), change: percentChange(aov(current), aov(previous)) },
      customers: { value: customers, new: newCustomers },
      vendors: { value: vendors, pending: pendingVendors },
      products: { value: products },
    },
    series: fillSeries(agg.series, days, ['gmv', 'commission', 'orders']),
    byStatus: agg.byStatus.map((s) => ({ status: s._id, count: s.count })),
    byCategory: agg.byCategory.map((c) => ({ category: c._id, name: names.get(c._id) || c._id, revenue: round2(c.revenue), units: c.units })),
    topProducts: agg.topProducts.map((p) => ({ ...p, revenue: round2(p.revenue) })),
    topVendors: agg.topVendors.map((v) => ({ ...v, gmv: round2(v.gmv), commission: round2(v.commission) })),
    recentOrders,
  });
}

/* --------------------------------------------------------------- vendors */

export const vendorUpdateSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional(),
  rejectionReason: z.string().trim().max(300).optional(),
  commissionRate: z.coerce.number().min(0).max(50).nullable().optional(),
  razorpayAccountId: z
    .string()
    .trim()
    .regex(/^acc_[A-Za-z0-9]{6,}$/, 'Linked account ids look like acc_XXXXXXXXXXXX')
    .or(z.literal(''))
    .optional(),
});

export async function listVendors(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 12 });
  const match = {};
  if (req.query.status) match.status = req.query.status;
  if (req.query.q) match.storeName = new RegExp(escapeRegex(req.query.q), 'i');

  const [items, total, counts] = await Promise.all([
    Vendor.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'owner', pipeline: [{ $project: { name: 1, email: 1 } }] } },
      { $lookup: { from: 'products', localField: '_id', foreignField: 'vendor', as: 'products', pipeline: [{ $project: { sold: 1 } }] } },
      { $set: { owner: { $first: '$owner' }, productCount: { $size: '$products' }, unitsSold: { $sum: '$products.sold' } } },
      { $project: { products: 0 } },
    ]),
    Vendor.countDocuments(match),
    Vendor.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  res.json({ ...paginated(items, total, page, limit), counts: Object.fromEntries(counts.map((c) => [c._id, c.count])) });
}

export async function updateVendor(req, res) {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) throw new ApiError(404, 'Vendor not found');
  const statusChanged = req.body.status && req.body.status !== vendor.status;
  Object.assign(vendor, req.body);
  if (statusChanged && vendor.status === 'approved') {
    vendor.approvedAt = new Date();
    vendor.rejectionReason = undefined;
  }
  await vendor.save();
  if (statusChanged) {
    // Store visibility changed -> refresh search docs, listings and cached product pages.
    const products = await Product.find({ vendor: vendor._id }).select('_id slug').lean();
    await invalidateProducts(products);
    await invalidateCatalog();
    indexProducts(products.map((p) => p._id));
  }
  res.json({ vendor });
}

/* ----------------------------------------------------------------- users */

export async function listUsers(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 15 });
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }
  const [items, total, counts] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select('name email role phone avatar isBlocked lastLoginAt createdAt').lean(),
    User.countDocuments(filter),
    User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
  ]);
  res.json({ ...paginated(items, total, page, limit), counts: Object.fromEntries(counts.map((c) => [c._id, c.count])) });
}

export const userUpdateSchema = z.object({ isBlocked: z.boolean() });

export async function updateUser(req, res) {
  if (req.params.id === req.user._id) throw new ApiError(400, 'You cannot change your own account here');
  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, 'User not found');
  if (user.role === 'admin') throw new ApiError(400, 'Admin accounts cannot be blocked');
  user.isBlocked = req.body.isBlocked;
  await user.save();
  await invalidateUser(user._id);
  res.json({ user: user.toSafeJSON() });
}

/* ---------------------------------------------------------------- orders */

export async function listOrders(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 15 });
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.payment) filter['payment.status'] = req.query.payment;
  if (req.query.q) filter.orderNumber = new RegExp(escapeRegex(req.query.q), 'i');
  const [items, total, counts] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('customer', 'name email')
      .select('orderNumber status pricing payment.status payment.provider createdAt customer packages.storeName packages.status packages.commission')
      .lean(),
    Order.countDocuments(filter),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  res.json({ ...paginated(items, total, page, limit), counts: Object.fromEntries(counts.map((c) => [c._id, c.count])) });
}

export const packageStatusSchema = z.object({
  status: z.enum(['packed', 'shipped', 'delivered', 'cancelled']),
  trackingId: z.string().trim().max(40).optional(),
  note: z.string().trim().max(200).optional(),
});

export async function updatePackage(req, res) {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, 'Order not found');
  const pkg = order.packages.id(req.params.packageId);
  if (!pkg) throw new ApiError(404, 'Package not found');
  await transitionPackage(order, pkg, req.body.status, { note: req.body.note || `Updated by admin`, trackingId: req.body.trackingId });
  await order.save();
  res.json({ order });
}

/* -------------------------------------------------------------- products */

export async function listProducts(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 15 });
  const filter = {};
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    filter.$or = [{ title: rx }, { brand: rx }];
  }
  if (req.query.category) filter.category = req.query.category;
  if (req.query.status === 'active') filter.isActive = true;
  if (req.query.status === 'inactive') filter.isActive = false;
  if (mongoose.isValidObjectId(req.query.vendor)) filter.vendor = req.query.vendor;
  const [items, total] = await Promise.all([
    Product.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('vendor', 'storeName slug')
      .select('title slug thumbnail price mrp stock category brand rating numReviews sold isActive vendor createdAt')
      .lean(),
    Product.countDocuments(filter),
  ]);
  res.json(paginated(items, total, page, limit));
}

export async function moderateProduct(req, res) {
  const product = await Product.findById(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found');
  product.isActive = Boolean(req.body.isActive);
  await product.save();
  await invalidateProducts([product]);
  await invalidateCatalog();
  await indexProducts([product._id]);
  res.json({ product });
}

/* ------------------------------------------------------- settings/system */

export const settingsSchema = z.object({
  commissionRate: z.coerce.number().min(0).max(50).optional(),
  shippingFee: z.coerce.number().min(0).max(1000).optional(),
  freeShippingThreshold: z.coerce.number().min(0).max(100000).optional(),
});

export async function getPlatformSettings(_req, res) {
  res.json({ settings: await getSettings() });
}

export async function updatePlatformSettings(req, res) {
  const settings = await Settings.findOneAndUpdate({ key: 'platform' }, { $set: req.body }, { new: true, upsert: true }).lean();
  await cache.del('settings');
  res.json({ settings });
}

export async function system(_req, res) {
  const [index, ping] = await Promise.all([indexStats(), cache.ping()]);
  res.json({
    database: { driver: 'mongodb', ...mongoStatus() },
    cache: { driver: cache.driver, healthy: ping === 'PONG' },
    search: { engine: searchEngine(), ...(index || {}) },
    storage: { driver: storageDriver() },
    payments: { provider: paymentProvider() },
  });
}

export async function reindex(_req, res) {
  if (searchEngine() !== 'elasticsearch') throw new ApiError(400, 'Elasticsearch is not connected; search is running on MongoDB');
  const count = await reindexAll();
  res.json({ message: `Indexed ${count} products`, count });
}
