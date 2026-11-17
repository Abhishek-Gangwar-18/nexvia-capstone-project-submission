import mongoose from 'mongoose';
import { logger } from '../utils/logger.ts';
import { z } from 'zod';
import { Order } from '../models/Order.ts';
import { User } from '../models/User.ts';
import { OWNER_BLOCKED, Vendor, VENDOR_TRANSITIONS } from '../models/Vendor.ts';
import { LISTED, Product } from '../models/Product.ts';
import { Category } from '../models/Category.ts';
import { Settings, SETTINGS_FIELDS, SETTINGS_LIMITS } from '../models/Settings.ts';
import { cache } from '../services/cache.ts';
import { getSettings } from '../services/pricing.ts';
import { invalidateUser, revokeAllSessions } from '../services/session.ts';
import { indexProducts, indexStats, productIdsMatching, reindexAll, searchConfigured, searchEngine } from '../services/search.ts';
import { pageByRank, searchEntityIds, toObjectIds } from '../services/entitySearch.ts';
import { invalidateCatalog, invalidateProducts } from '../services/catalog.ts';
import { transitionPackage, withPackageLock } from '../services/orders.ts';
import { buildOrderFilter, dateRange, EXCEPTION_TYPES, exceptionConditions, orderRow, ordersCsv, orderSort, SLA } from '../services/adminOrders.ts';
import { cancelReason } from '../utils/validators.ts';
import { storageDriver } from '../services/storage.ts';
import { paymentProvider } from '../services/payment.ts';
import { mongoStatus } from '../config/db.ts';
import { ApiError, escapeRegex, paginated, parsePagination, round2 } from '../utils/http.ts';
import { bucketFormat, fillSeries, percentChange, rangeStart, TIMEZONE } from '../utils/analytics.ts';

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
    Product.countDocuments(LISTED),
    Category.find().select('name').lean(),
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
  const names = new Map(categories.map((c) => [String(c._id), c.name]));

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
    byCategory: agg.byCategory.map((c) => ({ category: c._id, name: names.get(String(c._id)) || 'Deleted category', revenue: round2(c.revenue), units: c.units })),
    topProducts: agg.topProducts.map((p) => ({ ...p, revenue: round2(p.revenue) })),
    topVendors: agg.topVendors.map((v) => ({ ...v, gmv: round2(v.gmv), commission: round2(v.commission) })),
    recentOrders,
  });
}

/* --------------------------------------------------------------- vendors */

/** Payout details (bank, linked account) belong to the seller: admins can neither read nor change them. */
export const vendorUpdateSchema = z
  .object({
    status: z.enum(['approved', 'rejected', 'suspended']).optional(),
    rejectionReason: z.string().trim().max(300).optional(),
    commissionRate: z.coerce.number().min(0).max(50).nullable().optional(),
    /** Required when suspending a store that still has paid, unshipped packages: cancel+refund them or keep them. */
    openOrders: z.enum(['cancel', 'keep']).optional(),
  })
  .strict();

const PAYOUT_FIELDS = ['bank', 'stripe', 'payoutChanges'];

/** Vendor as admins see it: no payout details, only whether payouts are linked. */
function adminVendorView(vendor) {
  const v = typeof vendor.toObject === 'function' ? vendor.toObject() : { ...vendor };
  v.payoutLinked = Boolean(v.stripe?.payoutsEnabled);
  for (const f of PAYOUT_FIELDS) delete v[f];
  return v;
}

/** Store visibility changed -> refresh search docs, listings and cached product pages. */
async function refreshStoreVisibility(vendorId) {
  const products = await Product.find({ vendor: vendorId }).select('_id').lean();
  await invalidateProducts(products);
  await invalidateCatalog();
  indexProducts(products.map((p) => p._id));
}

export async function listVendors(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 12 });
  const match: Record<string, any> = {};
  if (req.query.status) match.status = req.query.status;
  if (req.query.payoutHold === '1') match['payoutHold.active'] = true;
  // Search: Elasticsearch (typo tolerant, best match first); MongoDB text match while it is unavailable.
  const hits = req.query.q ? await searchEntityIds('vendors', req.query.q) : null;
  if (hits) match._id = { $in: toObjectIds(hits) };
  else if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    match.$or = [{ storeName: rx }, { email: rx }, { tagline: rx }];
  }
  const order: mongoose.PipelineStage[] = hits ? [{ $set: { _rank: { $indexOfArray: [toObjectIds(hits), '$_id'] } } }, { $sort: { _rank: 1 } }] : [{ $sort: { createdAt: -1 } }];

  const [items, total, counts] = await Promise.all([
    Vendor.aggregate([
      { $match: match },
      ...order,
      { $skip: skip },
      { $limit: limit },
      { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'owner', pipeline: [{ $project: { name: 1, email: 1 } }] } },
      // Counted inside the lookup: one small document per store instead of every product it sells.
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: 'vendor',
          as: 'products',
          pipeline: [{ $group: { _id: null, count: { $sum: 1 }, sold: { $sum: '$sold' } } }],
        },
      },
      {
        $set: {
          owner: { $first: '$owner' },
          productCount: { $ifNull: [{ $first: '$products.count' }, 0] },
          unitsSold: { $ifNull: [{ $first: '$products.sold' }, 0] },
          payoutLinked: { $eq: ['$stripe.payoutsEnabled', true] },
        },
      },
      { $project: { products: 0, bank: 0, stripe: 0, payoutChanges: 0 } },
    ]),
    Vendor.countDocuments(match),
    Vendor.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  res.json({ ...paginated(items, total, page, limit), counts: Object.fromEntries(counts.map((c) => [c._id, c.count])) });
}

const OPEN_PACKAGE = ['placed', 'packed'];

/** Paid packages of a store that are not shipped yet (they need the seller to act). */
async function openPackages(vendorId) {
  const orders = await Order.find({ 'payment.status': 'paid', packages: { $elemMatch: { vendor: vendorId, status: { $in: OPEN_PACKAGE } } } })
    .select('_id packages._id packages.vendor packages.status')
    .lean();
  return orders.flatMap((o) =>
    o.packages.filter((p) => String(p.vendor) === String(vendorId) && OPEN_PACKAGE.includes(p.status)).map((p) => ({ orderId: o._id, packageId: p._id })),
  );
}

/**
 * Taking a store offline while customers still wait for paid packages: the admin must say what happens
 * to them (409 OPEN_ORDERS with the count otherwise). 'cancel' cancels and refunds each one.
 */
async function assertOpenOrdersDecision(vendorId, choice) {
  const open = await openPackages(vendorId);
  if (open.length && !choice) {
    const plural = open.length > 1 ? 's' : '';
    throw new ApiError(409, `This store has ${open.length} paid order${plural} not shipped yet. Choose whether to cancel and refund them or keep them.`, {
      code: 'OPEN_ORDERS',
      count: open.length,
    });
  }
  return open;
}

async function cancelOpenPackages(open, adminId, note) {
  let cancelled = 0;
  for (const { orderId, packageId } of open) {
    try {
      await withPackageLock(packageId, async () => {
        const order = await Order.findById(orderId);
        const pkg = order?.packages.id(packageId);
        if (!pkg || !OPEN_PACKAGE.includes(pkg.status)) return; // shipped or cancelled meanwhile
        await transitionPackage(order, pkg, 'cancelled', {
          note: `Cancelled by admin (vendor_unable): ${note}`,
          cancellation: { by: 'admin', actorId: adminId, reasonCode: 'vendor_unable', note },
        });
        await order.save();
        cancelled += 1;
      });
    } catch (err) {
      logger.warn(`Could not cancel package ${packageId} of a suspended store: ${err.message}`);
    }
  }
  return cancelled;
}

export async function updateVendor(req, res) {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) throw new ApiError(404, 'Vendor not found');
  const { status, rejectionReason, openOrders, ...rest } = req.body;
  const statusChanged = status && status !== vendor.status;
  if (statusChanged) {
    if (!VENDOR_TRANSITIONS[vendor.status].includes(status)) {
      const allowed = VENDOR_TRANSITIONS[vendor.status];
      throw new ApiError(400, `${/^[aeiou]/.test(vendor.status) ? "An" : "A"} ${vendor.status} store cannot be moved to ${status}${allowed.length ? ` (allowed: ${allowed.join(', ')})` : vendor.status === 'rejected' ? '. The seller has to resubmit first' : ''}`);
    }
    if (['rejected', 'suspended'].includes(status) && !rejectionReason) {
      throw new ApiError(400, `Give a reason when a store is ${status}`);
    }
    if (status === 'approved') {
      const owner = await User.findById(vendor.user).select('status').lean();
      if (owner?.status === 'blocked') throw new ApiError(400, "The store owner's account is blocked. Unblock the user first");
    }
  }
  const open = statusChanged && status === 'suspended' ? await assertOpenOrdersDecision(vendor._id, openOrders) : [];
  if (statusChanged) {
    // Only from the status this admin saw: a second admin acting at the same moment gets 409, not a double change.
    const claimed = await Vendor.updateOne({ _id: vendor._id, status: vendor.status }, { $set: { status } });
    if (!claimed.modifiedCount) throw new ApiError(409, 'This store was just changed by someone else. Reload and try again.');
  }
  Object.assign(vendor, rest);
  if (statusChanged) vendor.setStatus(status, { reason: rejectionReason, by: req.user._id });
  await vendor.save();
  if (statusChanged) await refreshStoreVisibility(vendor._id);
  const cancelledOrders = openOrders === 'cancel' && open.length ? await cancelOpenPackages(open, req.user._id, rejectionReason) : 0;
  res.json({ vendor: adminVendorView(vendor), ...(open.length && { openOrders: { count: open.length, cancelled: cancelledOrders } }) });
}

/* ----------------------------------------------------------------- users */

export async function listUsers(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 15 });
  const filter: Record<string, any> = {};
  if (req.query.role) filter.role = req.query.role;
  const fields = 'name email role phone avatar status blockedReason blockedAt lastLoginAt createdAt';
  const hits = req.query.q ? await searchEntityIds('users', req.query.q) : null;
  if (!hits && req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }
  const [{ items, total }, counts] = await Promise.all([
    hits
      ? pageByRank(User, filter, hits, { skip, limit, query: (ids) => User.find({ _id: { $in: ids } }).select(fields).lean() })
      : Promise.all([User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select(fields).lean(), User.countDocuments(filter)]).then(([list, n]) => ({ items: list, total: n })),
    User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
  ]);
  res.json({ ...paginated(items, total, page, limit), counts: Object.fromEntries(counts.map((c) => [c._id, c.count])) });
}

export const userUpdateSchema = z
  .object({
    status: z.enum(['active', 'blocked']),
    reason: z.string().trim().max(300).optional(),
    /** Blocking a seller suspends their store: same choice as suspending it directly. */
    openOrders: z.enum(['cancel', 'keep']).optional(),
  })
  .refine((b) => b.status !== 'blocked' || b.reason, { message: 'Give a reason for blocking this user', path: ['reason'] });

export async function updateUser(req, res) {
  if (String(req.params.id) === String(req.user._id)) throw new ApiError(400, 'You cannot change your own account here');
  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, 'User not found');
  if (user.role === 'admin') throw new ApiError(400, 'Admin accounts cannot be blocked');
  const blocked = req.body.status === 'blocked';
  // Blocking a seller suspends their store, so the same open-orders decision applies.
  let open = [];
  if (blocked && user.role === 'vendor') {
    const store = await Vendor.findOne({ user: user._id, status: 'approved' }).select('_id').lean();
    if (store) open = await assertOpenOrdersDecision(store._id, req.body.openOrders);
  }
  if ((user.status || 'active') !== req.body.status) {
    // Only from the status this admin saw: two admins acting at once can't both apply a change.
    const from = user.status ? [user.status] : [null, 'active'];
    const claimed = await User.updateOne({ _id: user._id, status: { $in: from } }, { $set: { status: req.body.status } });
    if (!claimed.modifiedCount) throw new ApiError(409, 'This account was just changed by someone else. Reload and try again.');
  }
  user.status = req.body.status;
  user.blockedReason = blocked ? req.body.reason : undefined;
  user.blockedAt = blocked ? new Date() : undefined;
  user.blockedBy = blocked ? req.user._id : undefined;
  await user.save();
  if (blocked) await revokeAllSessions(user._id, 'blocked');
  // After the revocation: a request of theirs that read the old profile meanwhile can't leave it cached.
  await invalidateUser(user._id);
  const store = user.role === 'vendor' ? await syncStoreWithOwner(user, req) : undefined;
  const cancelledOrders = req.body.openOrders === 'cancel' && open.length ? await cancelOpenPackages(open, req.user._id, req.body.reason) : 0;
  res.json({ user: user.toSafeJSON(), ...(store && { store }), ...(open.length && { openOrders: { count: open.length, cancelled: cancelledOrders } }) });
}

/**
 * Blocking a seller takes their store offline (suspended, so the storefront and products 404);
 * unblocking restores it only if the block was what suspended it.
 */
async function syncStoreWithOwner(user, req) {
  const vendor = await Vendor.findOne({ user: user._id });
  if (!vendor) return undefined;
  const blocked = user.status === 'blocked';
  const lastReason = vendor.statusHistory.at(-1)?.reason || '';
  if (blocked && vendor.status === 'approved') {
    vendor.setStatus('suspended', { reason: `${OWNER_BLOCKED}: ${req.body.reason}`, by: req.user._id });
  } else if (!blocked && vendor.status === 'suspended' && lastReason.startsWith(OWNER_BLOCKED)) {
    vendor.setStatus('approved', { reason: 'Owner account unblocked', by: req.user._id });
  } else {
    return { _id: vendor._id, status: vendor.status, changed: false };
  }
  await vendor.save();
  await refreshStoreVisibility(vendor._id);
  return { _id: vendor._id, status: vendor.status, changed: true };
}

/* ---------------------------------------------------------------- orders */

const ROW_FIELDS =
  'orderNumber status createdAt placedAt customer pricing payment.status payment.provider reservation ' +
  'packages._id packages.vendor packages.storeName packages.status packages.trackingId packages.refund packages.timeline ' +
  'packages.items.product packages.items.title packages.items.quantity';

/** Admin order table: every search/filter runs on the server (see services/adminOrders.ts). */
export async function listOrders(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 15 });
  const filter = await buildOrderFilter(req.query);
  const [orders, total, counts, attention] = await Promise.all([
    Order.find(filter).sort(orderSort(req.query.sort)).skip(skip).limit(limit).populate('customer', 'name email').select(ROW_FIELDS).lean(),
    Order.countDocuments(filter),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.countDocuments({ $or: Object.values(exceptionConditions()) }),
  ]);
  const now = new Date();
  res.json({
    ...paginated(orders.map((o) => orderRow(o, now)), total, page, limit),
    counts: { ...Object.fromEntries(counts.map((c) => [c._id, c.count])), attention },
  });
}

const PAID = ['paid', 'refunded'];
const REFUNDED = ['processed', 'pending'];
const sumIf = (cond, value) => ({ $sum: { $cond: [cond, value, 0] } });

/**
 * KPIs for the selected range (?range / ?from&to). Order-level money is summed once per order and
 * package-level counts are computed separately, so multi-vendor orders are never double counted.
 * Exception counts are current state and ignore the range.
 */
export async function orderSummary(req, res) {
  const created = dateRange({ range: req.query.range ?? '30', from: req.query.from, to: req.query.to });
  const match = created ? { createdAt: created } : {};
  const rules = exceptionConditions();
  const deliveredAt = { $max: { $map: { input: { $filter: { input: '$packages.timeline', cond: { $eq: ['$$this.status', 'delivered'] } } }, in: '$$this.at' } } };

  const [[agg], ...exceptionCounts] = await Promise.all([
    Order.aggregate([
      { $match: match },
      {
        $facet: {
          orders: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                placed: sumIf({ $gt: ['$placedAt', null] }, 1),
                paid: sumIf({ $in: ['$payment.status', PAID] }, 1),
                gross: sumIf({ $in: ['$payment.status', PAID] }, '$pricing.total'),
                cancelled: sumIf({ $eq: ['$status', 'cancelled'] }, 1),
                paymentPending: sumIf({ $eq: ['$payment.status', 'pending'] }, 1),
                paymentFailed: sumIf({ $eq: ['$payment.status', 'failed'] }, 1),
              },
            },
          ],
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          packages: [
            { $unwind: '$packages' },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                awaiting: sumIf({ $in: ['$packages.status', ['placed', 'packed']] }, 1),
                inTransit: sumIf({ $eq: ['$packages.status', 'shipped'] }, 1),
                delivered: sumIf({ $eq: ['$packages.status', 'delivered'] }, 1),
                cancelled: sumIf({ $eq: ['$packages.status', 'cancelled'] }, 1),
                refundCount: sumIf({ $in: ['$packages.refund.status', REFUNDED] }, 1),
                refundAmount: sumIf({ $in: ['$packages.refund.status', REFUNDED] }, '$packages.refund.amount'),
                failedRefundCount: sumIf({ $eq: ['$packages.refund.status', 'failed'] }, 1),
                failedRefundAmount: sumIf({ $eq: ['$packages.refund.status', 'failed'] }, '$packages.refund.amount'),
              },
            },
          ],
          fulfilment: [
            { $unwind: '$packages' },
            { $match: { 'packages.status': 'delivered', placedAt: { $ne: null } } },
            { $project: { hours: { $divide: [{ $subtract: [deliveredAt, '$placedAt'] }, 3600000] } } },
            { $group: { _id: null, avgHours: { $avg: '$hours' } } },
          ],
          vendors: [
            { $unwind: '$packages' },
            { $match: { 'packages.status': { $ne: 'pending' } } },
            {
              $group: {
                _id: '$packages.vendor',
                storeName: { $last: '$packages.storeName' },
                packages: { $sum: 1 },
                delivered: sumIf({ $eq: ['$packages.status', 'delivered'] }, 1),
                cancelled: sumIf({ $eq: ['$packages.status', 'cancelled'] }, 1),
                open: sumIf({ $in: ['$packages.status', ['placed', 'packed', 'shipped']] }, 1),
                sales: sumIf({ $ne: ['$packages.status', 'cancelled'] }, '$packages.total'),
              },
            },
            { $sort: { packages: -1 } },
            { $limit: 10 },
          ],
        },
      },
    ]),
    ...EXCEPTION_TYPES.map((type) => Order.countDocuments(rules[type])),
    Order.countDocuments({ $or: Object.values(rules) }),
  ]);

  const o = agg.orders[0] || { total: 0, placed: 0, paid: 0, gross: 0, cancelled: 0, paymentPending: 0, paymentFailed: 0 };
  const p = agg.packages[0] || { total: 0, awaiting: 0, inTransit: 0, delivered: 0, cancelled: 0, refundCount: 0, refundAmount: 0, failedRefundCount: 0, failedRefundAmount: 0 };
  const attentionTotal = exceptionCounts.pop();
  const exceptions = Object.fromEntries(EXCEPTION_TYPES.map((type, i) => [type, exceptionCounts[i]]));
  res.json({
    range: created ? { from: created.$gte ?? null, to: created.$lte ?? null } : null,
    orders: { total: o.total, placed: o.placed, paid: o.paid, cancelled: o.cancelled, byStatus: Object.fromEntries(agg.byStatus.map((x) => [x._id, x.count])) },
    sales: { gross: round2(o.gross), refunded: round2(p.refundAmount), net: round2(o.gross - p.refundAmount), aov: o.paid ? round2(o.gross / o.paid) : 0 },
    packages: { total: p.total, awaiting: p.awaiting, inTransit: p.inTransit, delivered: p.delivered, cancelled: p.cancelled },
    payments: { pending: o.paymentPending, failed: o.paymentFailed },
    refunds: { count: p.refundCount, amount: round2(p.refundAmount), failedCount: p.failedRefundCount, failedAmount: round2(p.failedRefundAmount) },
    cancellationRate: o.placed ? round2((o.cancelled / o.placed) * 100) : 0,
    avgFulfilmentHours: agg.fulfilment[0] ? round2(agg.fulfilment[0].avgHours) : null,
    delayed: { dispatch: exceptions.delayed_dispatch, delivery: exceptions.delayed_delivery },
    exceptions: { ...exceptions, total: attentionTotal },
    vendorPerformance: agg.vendors.map((v) => ({
      vendor: v._id,
      storeName: v.storeName,
      packages: v.packages,
      delivered: v.delivered,
      cancelled: v.cancelled,
      open: v.open,
      sales: round2(v.sales),
      fulfilmentRate: v.packages ? round2((v.delivered / v.packages) * 100) : 0,
      cancellationRate: v.packages ? round2((v.cancelled / v.packages) * 100) : 0,
    })),
    sla: SLA,
  });
}

const EXPORT_MAX = 5000;

/** CSV of the filtered list, in pages of up to 5000 rows (?page, ?limit). X-Total-Count has the full size. */
export async function exportOrders(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: EXPORT_MAX, maxLimit: EXPORT_MAX });
  const filter = await buildOrderFilter(req.query);
  const [orders, total] = await Promise.all([
    Order.find(filter).sort(orderSort(req.query.sort)).skip(skip).limit(limit).select(ROW_FIELDS).lean(),
    Order.countDocuments(filter),
  ]);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}-p${page}.csv"`,
    'X-Total-Count': String(total),
    'X-Total-Pages': String(Math.max(1, Math.ceil(total / limit))),
    'Access-Control-Expose-Headers': 'X-Total-Count, X-Total-Pages, Content-Disposition',
  });
  res.send(ordersCsv(orders));
}

export const packageStatusSchema = z
  .object({
    status: z.enum(['packed', 'shipped', 'delivered', 'cancelled']),
    trackingId: z.string().trim().max(40).optional(),
    note: z.string().trim().max(200).optional(),
    reasonCode: z.string().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.status !== 'cancelled') return;
    const r = cancelReason('admin').safeParse(b);
    if (!r.success) r.error.issues.forEach((issue) => ctx.addIssue(issue));
  });

export async function updatePackage(req, res) {
  const order = await withPackageLock(req.params.packageId, async () => {
    const fresh = await Order.findById(req.params.id);
    if (!fresh) throw new ApiError(404, 'Order not found');
    const pkg = fresh.packages.id(req.params.packageId);
    if (!pkg) throw new ApiError(404, 'Package not found');
    const { status, note, trackingId, reasonCode } = req.body;
    const cancellation = status === 'cancelled' ? { by: 'admin', actorId: req.user._id, reasonCode, note } : undefined;
    await transitionPackage(fresh, pkg, status, {
      note: status === 'cancelled' ? `Cancelled by admin (${reasonCode})${note ? `: ${note}` : ''}` : note || 'Updated by admin',
      trackingId,
      cancellation,
    });
    await fresh.save();
    return fresh;
  });
  res.json({ order });
}

/* -------------------------------------------------------------- products */

export async function listProducts(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 15 });
  const filter: Record<string, any> = {};
  const hits = req.query.q ? await productIdsMatching(req.query.q) : null;
  if (!hits && req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    filter.$or = [{ title: rx }, { brand: rx }];
  }
  if (mongoose.isValidObjectId(req.query.category)) filter.category = req.query.category;
  if (req.query.status === 'active') Object.assign(filter, LISTED);
  if (req.query.status === 'inactive') filter.isActive = false;
  if (req.query.status === 'removed') filter['moderation.status'] = 'removed';
  if (req.query.status === 'deleted') filter.deletedAt = { $ne: null };
  if (mongoose.isValidObjectId(req.query.vendor)) filter.vendor = req.query.vendor;
  const fields = 'title thumbnail price mrp stock category brand rating numRatings sold isActive moderation deletedAt vendor createdAt';
  const load = (query) => query.populate('vendor', 'storeName').select(fields).lean();
  const { items, total } = hits
    ? await pageByRank(Product, filter, hits, { skip, limit, query: (ids) => load(Product.find({ _id: { $in: ids } })) })
    : await Promise.all([load(Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)), Product.countDocuments(filter)]).then(([list, n]) => ({ items: list, total: n }));
  res.json(paginated(items, total, page, limit));
}

export const moderationSchema = z
  .object({ status: z.enum(['approved', 'removed']), reason: z.string().trim().max(300).optional() })
  .refine((b) => b.status !== 'removed' || b.reason, { message: 'Give a reason for removing this product', path: ['reason'] });

export async function moderateProduct(req, res) {
  const product = await Product.findById(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found');
  const removed = req.body.status === 'removed';
  product.moderation = { status: req.body.status, reason: removed ? req.body.reason : undefined, by: req.user._id, at: new Date() };
  await product.save();
  await invalidateProducts([product]);
  await invalidateCatalog();
  await indexProducts([product._id]);
  res.json({ product });
}

/* ------------------------------------------------------- settings/system */

const settingField = (field) => z.coerce.number().min(SETTINGS_LIMITS[field].min).max(SETTINGS_LIMITS[field].max).optional();
export const settingsSchema = z
  .object(Object.fromEntries(SETTINGS_FIELDS.map((f) => [f, settingField(f)])))
  .refine((b) => Object.keys(b).length > 0, 'Send at least one setting to change');

/** Current settings plus the latest changes (newest first) with who made them. */
export async function getPlatformSettings(_req, res) {
  const [settings, doc] = await Promise.all([getSettings(), Settings.findOne({ key: 'platform' }).select('history').populate('history.by', 'name email').lean()]);
  res.json({ settings, history: (doc?.history || []).slice(-20).reverse() });
}

export async function updatePlatformSettings(req, res) {
  const settings = (await Settings.findOne({ key: 'platform' })) || new Settings({ key: 'platform' });
  settings.applyChanges(req.body, req.user._id);
  await settings.save(); // schema rules, incl. threshold vs fee, run here
  await cache.del('settings');
  res.json({ settings: settings.toObject() });
}

export async function system(_req, res) {
  const [index, ping] = await Promise.all([indexStats(), cache.ping()]);
  res.json({
    database: { driver: 'mongodb', ...mongoStatus() },
    cache: { driver: cache.driver, healthy: ping === 'PONG' },
    search: { engine: searchEngine(), configured: searchConfigured(), ...(index || {}) },
    storage: { driver: storageDriver() },
    payments: { provider: paymentProvider() },
  });
}

export async function reindex(_req, res) {
  if (searchEngine() !== 'elasticsearch') throw new ApiError(400, 'Elasticsearch is not connected; search is running on MongoDB');
  const count = await reindexAll();
  res.json({ message: `Indexed ${count} products`, count });
}
