import mongoose from 'mongoose';
import { searchEntityIds, toObjectIds } from './entitySearch.ts';
import { productIdsMatching } from './search.ts';
import { User } from '../models/User.ts';
import { ApiError, escapeRegex, round2 } from '../utils/http.ts';

/** Fulfilment SLAs used to flag delayed packages. */
export const SLA = { dispatchHours: 48, deliveryDays: 7 };
const HOUR = 60 * 60 * 1000;
const IST = '+05:30'; // dates in filters are calendar days in Asia/Kolkata (utils/analytics TIMEZONE)

export const ORDER_SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  total_desc: { 'pricing.total': -1, createdAt: -1 },
  total_asc: { 'pricing.total': 1, createdAt: -1 },
};

const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;

/** ?range=today|7|30|90|365 or ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive) -> a createdAt condition, or null. */
export function dateRange({ range, from, to }: Record<string, any> = {}) {
  if (from || to) {
    if ((from && !DAY_RX.test(from)) || (to && !DAY_RX.test(to))) throw new ApiError(400, 'from and to must be dates like 2026-10-29');
    const cond: Record<string, any> = {};
    if (from) cond.$gte = new Date(`${from}T00:00:00${IST}`);
    if (to) cond.$lte = new Date(`${to}T23:59:59.999${IST}`);
    if (cond.$gte && cond.$lte && cond.$gte > cond.$lte) throw new ApiError(400, '"from" must be on or before "to"');
    return cond;
  }
  if (!range || range === 'all') return null;
  if (range === 'today') {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    return { $gte: new Date(`${today}T00:00:00${IST}`) };
  }
  const days = Number(range);
  if (![7, 30, 90, 365].includes(days)) throw new ApiError(400, 'range must be today, 7, 30, 90, 365 or all');
  return { $gte: new Date(Date.now() - days * 24 * HOUR) };
}

/** Mongo conditions for each "needs attention" exception. These are current-state checks, not date-bound. */
export function exceptionConditions(now = new Date()) {
  const dispatchCutoff = new Date(+now - SLA.dispatchHours * HOUR);
  const deliveryCutoff = new Date(+now - SLA.deliveryDays * 24 * HOUR);
  return {
    refund_failed: { 'packages.refund.status': 'failed' },
    payout_reversal_failed: { 'packages.payout.status': 'reversal_failed' },
    payment_mismatch: {
      $or: [
        { 'payment.status': 'paid', status: { $in: ['pending_payment', 'payment_failed'] } },
        { 'payment.status': { $in: ['pending', 'failed'] }, 'packages.status': { $in: ['placed', 'packed', 'shipped', 'delivered'] } },
        // Every package cancelled but the money was never returned.
        { 'payment.status': 'paid', status: 'cancelled' },
      ],
    },
    stock_issue: {
      $or: [
        { 'reservation.status': 'held', 'reservation.expiresAt': { $lt: now } },
        { 'reservation.status': 'held', 'payment.status': 'paid' },
      ],
    },
    delayed_dispatch: { placedAt: { $lt: dispatchCutoff }, packages: { $elemMatch: { status: { $in: ['placed', 'packed'] } } } },
    delayed_delivery: {
      packages: { $elemMatch: { status: 'shipped', timeline: { $elemMatch: { status: 'shipped', at: { $lt: deliveryCutoff } } } } },
    },
    missing_tracking: { packages: { $elemMatch: { status: { $in: ['shipped', 'delivered'] }, trackingId: { $in: [null, ''] } } } },
  };
}
export const EXCEPTION_TYPES = Object.keys(exceptionConditions());

const shippedAt = (pkg) => pkg.timeline?.find((t) => t.status === 'shipped')?.at;

/** The same rules as exceptionConditions, evaluated on one loaded order, with a reason for each hit. */
export function orderExceptions(order, now = new Date()) {
  const out = [];
  const pay = order.payment?.status;
  const add = (type: string, reason: string, pkg?: any, at?: unknown) => out.push({ type, reason, packageId: pkg?._id, storeName: pkg?.storeName, at });

  for (const pkg of order.packages || []) {
    if (pkg.refund?.status === 'failed') add('refund_failed', `Refund of ${pkg.refund.amount} failed: ${pkg.refund.error || 'unknown error'}`, pkg, pkg.refund.at);
    if (pkg.payout?.status === 'reversal_failed') add('payout_reversal_failed', `Vendor payout of ${pkg.vendorEarning} was not reversed: ${pkg.payout.reversalError || 'unknown error'}`, pkg, pkg.cancellation?.at);
    if (['placed', 'packed'].includes(pkg.status) && order.placedAt && +now - +new Date(order.placedAt) > SLA.dispatchHours * HOUR) {
      add('delayed_dispatch', `Not shipped ${SLA.dispatchHours}h after the order was placed`, pkg, order.placedAt);
    }
    const shipped = shippedAt(pkg);
    if (pkg.status === 'shipped' && shipped && +now - +new Date(shipped) > SLA.deliveryDays * 24 * HOUR) {
      add('delayed_delivery', `In transit for more than ${SLA.deliveryDays} days`, pkg, shipped);
    }
    if (['shipped', 'delivered'].includes(pkg.status) && !pkg.trackingId) add('missing_tracking', 'Shipped without a tracking ID', pkg, shipped);
  }
  const live = (order.packages || []).some((p) => ['placed', 'packed', 'shipped', 'delivered'].includes(p.status));
  if (pay === 'paid' && ['pending_payment', 'payment_failed'].includes(order.status)) add('payment_mismatch', 'Payment is paid but the order is still unpaid');
  else if (['pending', 'failed'].includes(pay) && live) add('payment_mismatch', `Payment is ${pay} but packages are being fulfilled`);
  else if (pay === 'paid' && order.status === 'cancelled') add('payment_mismatch', 'Order cancelled but the payment was not refunded');
  if (order.reservation?.status === 'held') {
    if (pay === 'paid') add('stock_issue', 'Paid order still holds a stock reservation (commit did not run)', null, order.placedAt);
    else if (order.reservation.expiresAt && new Date(order.reservation.expiresAt) < now) add('stock_issue', 'Reservation expired but stock was not released', null, order.reservation.expiresAt);
  }
  return out;
}

const objectId = (value, name) => {
  if (!mongoose.isValidObjectId(value)) throw new ApiError(400, `Invalid ${name} id`);
  return new mongoose.Types.ObjectId(value);
};
const amount = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `${name} must be a positive number`);
  return n;
};

const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'refunded'];
const PACKAGE_STATUSES = ['pending', 'placed', 'packed', 'shipped', 'delivered', 'cancelled'];
const ORDER_STATUSES = ['pending_payment', 'placed', 'processing', 'shipped', 'delivered', 'cancelled', 'payment_failed'];
const REFUND_FILTERS = ['failed', 'processed', 'pending', 'any', 'none'];
const oneOf = (value, allowed, name) => {
  if (!allowed.includes(value)) throw new ApiError(400, `${name} must be one of: ${allowed.join(', ')}`);
  return value;
};

/** Search across order, customer, vendor, product and payment/shipping/refund references. */
async function searchCondition(term) {
  const rx = new RegExp(escapeRegex(term), 'i');
  const exact = new RegExp(`^${escapeRegex(term)}$`, 'i');
  const or: Record<string, any>[] = [
    { orderNumber: rx },
    { 'packages.storeName': rx },
    { 'packages.items.title': rx },
    { 'payment.paymentId': exact },
    { 'payment.intentId': exact },
    { 'packages.trackingId': exact },
    { 'packages.refund.id': exact },
  ];
  if (mongoose.isValidObjectId(term)) {
    const id = new mongoose.Types.ObjectId(term);
    or.push({ _id: id }, { customer: id }, { 'packages.vendor': id }, { 'packages.items.product': id });
  }
  // Customers, stores and products by name with typos allowed (Elasticsearch); MongoDB match as a fallback.
  const [users, stores, products] = await Promise.all([
    searchEntityIds('users', term, { size: 200 }),
    searchEntityIds('vendors', term, { size: 100 }),
    productIdsMatching(term, { size: 200 }),
  ]);
  const customers = users ? toObjectIds(users) : (await User.find({ $or: [{ name: rx }, { email: rx }] }).select('_id').limit(200).lean()).map((u) => u._id);
  if (customers.length) or.push({ customer: { $in: customers } });
  if (stores?.length) or.push({ 'packages.vendor': { $in: toObjectIds(stores) } });
  if (products?.length) or.push({ 'packages.items.product': { $in: toObjectIds(products) } });
  return { $or: or };
}

/** Builds the Mongo filter for the admin order list and export from the query string. Unknown values -> 400. */
export async function buildOrderFilter(query) {
  const and = [];
  const created = dateRange(query);
  if (created) and.push({ createdAt: created });
  if (query.status) and.push({ status: oneOf(query.status, ORDER_STATUSES, 'status') });
  if (query.payment) and.push({ 'payment.status': oneOf(query.payment, PAYMENT_STATUSES, 'payment') });
  if (query.fulfilment) and.push({ 'packages.status': oneOf(query.fulfilment, PACKAGE_STATUSES, 'fulfilment') });
  if (query.refund) {
    const refund = oneOf(query.refund, REFUND_FILTERS, 'refund');
    if (refund === 'any') and.push({ 'packages.refund.status': { $exists: true } });
    else if (refund === 'none') and.push({ 'packages.refund.status': { $exists: false } });
    else and.push({ 'packages.refund.status': refund });
  }
  if (query.vendor) and.push({ 'packages.vendor': objectId(query.vendor, 'vendor') });
  if (query.product) and.push({ 'packages.items.product': objectId(query.product, 'product') });
  if (mongoose.isValidObjectId(query.category)) and.push({ 'packages.items.category': new mongoose.Types.ObjectId(String(query.category)) });
  if (query.minTotal || query.maxTotal) {
    const total: Record<string, any> = {};
    if (query.minTotal) total.$gte = amount(query.minTotal, 'minTotal');
    if (query.maxTotal) total.$lte = amount(query.maxTotal, 'maxTotal');
    if (total.$gte > total.$lte) throw new ApiError(400, 'minTotal must not be greater than maxTotal');
    and.push({ 'pricing.total': total });
  }
  const rules = exceptionConditions();
  if (query.attention) {
    if (query.attention === 'all' || query.attention === 'true') and.push({ $or: Object.values(rules) });
    else and.push(rules[oneOf(query.attention, EXCEPTION_TYPES, 'attention')]);
  }
  if (query.delayed === 'true') and.push({ $or: [rules.delayed_dispatch, rules.delayed_delivery] });
  if (query.q?.trim()) and.push(await searchCondition(query.q.trim()));
  return and.length ? { $and: and } : {};
}

export const orderSort = (sort = 'newest') => ORDER_SORTS[oneOf(sort, Object.keys(ORDER_SORTS), 'sort')];

/** Worst refund state across packages: failed > pending > processed > none. */
export function refundSummary(order) {
  const refunds = (order.packages || []).map((p) => p.refund).filter((r) => r?.status);
  if (!refunds.length) return { status: 'none', amount: 0 };
  const status = ['failed', 'pending', 'processed'].find((s) => refunds.some((r) => r.status === s)) || refunds[0].status;
  const amount = round2(refunds.filter((r) => r.status !== 'failed').reduce((s, r) => s + (r.amount || 0), 0));
  return { status, amount, failedAmount: round2(refunds.filter((r) => r.status === 'failed').reduce((s, r) => s + (r.amount || 0), 0)) };
}

/** One table row: order-level totals, an item summary, independent payment/fulfilment/refund states. */
export function orderRow(order, now = new Date()) {
  const items = order.packages.flatMap((p) => p.items);
  return {
    _id: order._id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    status: order.status,
    customer: order.customer,
    vendors: order.packages.map((p) => ({ _id: p.vendor, storeName: p.storeName })),
    items: {
      count: items.reduce((s, i) => s + i.quantity, 0),
      lines: items.map((i) => ({ product: i.product, title: i.title, quantity: i.quantity })),
    },
    total: order.pricing.total,
    payment: { status: order.payment.status, provider: order.payment.provider },
    fulfilment: order.packages.map((p) => ({ _id: p._id, storeName: p.storeName, status: p.status, trackingId: p.trackingId })),
    refund: refundSummary(order),
    exceptions: orderExceptions(order, now),
  };
}

const CSV_COLUMNS = ['Order', 'Created', 'Status', 'Payment', 'Provider', 'Customer ID', 'Vendors', 'Items', 'Subtotal', 'Discount', 'Shipping', 'Total', 'Package statuses', 'Refunded', 'Refund status', 'Exceptions'];
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  // Quote when needed; prefix formula-like cells so spreadsheets don't execute them.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** CSV with only operational fields: no customer name, email, phone or address. */
export function ordersCsv(orders, now = new Date()) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const o of orders) {
    const row = orderRow(o, now);
    lines.push(
      [
        o.orderNumber,
        new Date(o.createdAt).toISOString(),
        o.status,
        o.payment.status,
        o.payment.provider,
        o.customer?._id ?? o.customer,
        row.vendors.map((v) => v.storeName).join(' | '),
        row.items.count,
        o.pricing.subtotal,
        o.pricing.discount,
        o.pricing.shipping,
        o.pricing.total,
        row.fulfilment.map((p) => `${p.storeName}: ${p.status}`).join(' | '),
        row.refund.amount,
        row.refund.status,
        row.exceptions.map((e) => e.type).join(' | '),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}
