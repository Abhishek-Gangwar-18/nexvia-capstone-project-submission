import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { Return } from '../models/Return.js';
import { issueRefund, settlePaymentStatus } from './refunds.js';
import { RETURN_WINDOW_DAYS } from './payouts.js';
import { afterStockChange } from './orders.js';
import { ApiError, round2 } from '../utils/http.js';

const DAY = 24 * 60 * 60 * 1000;
/** Returns that still count against the purchased quantity. */
const COUNTED = { $nin: ['rejected', 'cancelled'] };

export const deliveredAt = (pkg) => pkg.timeline.find((t) => t.status === 'delivered')?.at;

/** Last moment a package can be returned, or null when it hasn't been delivered. */
export function returnDeadline(pkg) {
  const at = deliveredAt(pkg);
  return at ? new Date(new Date(at).getTime() + RETURN_WINDOW_DAYS * DAY) : null;
}

/** What was paid for one unit of an item: its price minus its proportional share of the coupon. */
const unitPaid = (pkg, item) => (pkg.subtotal > 0 ? (item.total / item.quantity) * (pkg.total / pkg.subtotal) : 0);

/** Units of each product already in a (non-rejected, non-cancelled) return for this package. */
async function alreadyReturned(pkgId) {
  const rows = await Return.aggregate([
    { $match: { package: pkgId, status: COUNTED } },
    { $unwind: '$items' },
    { $group: { _id: '$items.product', quantity: { $sum: '$items.quantity' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.quantity]));
}

const push = (ret, status, by, actorId, note) => ret.timeline.push({ status, by, actorId, note, at: new Date() });

/** Customer: asks to return items of a delivered package, inside the return window. */
export async function requestReturn(user, orderId, { packageId, items, reasonCode, note, photos = [] }) {
  const order = await Order.findOne({ _id: orderId, customer: user._id });
  if (!order) throw new ApiError(404, 'Order not found');
  const pkg = order.packages.id(packageId);
  if (!pkg) throw new ApiError(404, 'Package not found');
  if (pkg.status !== 'delivered') throw new ApiError(400, 'Only delivered packages can be returned');
  const deadline = returnDeadline(pkg);
  if (!deadline || Date.now() > deadline.getTime()) throw new ApiError(400, `Returns are accepted within ${RETURN_WINDOW_DAYS} days of delivery`);
  if (pkg.payout.status === 'released') throw new ApiError(400, 'The return window for this package has closed');

  const returned = await alreadyReturned(pkg._id);
  const lines = items.map(({ product, quantity }) => {
    const item = pkg.items.find((i) => String(i.product) === String(product));
    if (!item) throw new ApiError(400, 'That item is not in this package');
    const left = item.quantity - (returned.get(String(product)) || 0);
    if (quantity > left) throw new ApiError(400, left ? `You can return at most ${left} of "${item.title}"` : `"${item.title}" has already been returned`);
    return { product: item.product, title: item.title, quantity, amount: round2(unitPaid(pkg, item) * quantity) };
  });

  // Shipping comes back only when this return completes the whole package and no other package is live.
  const completesPackage = pkg.items.every((i) => (returned.get(String(i.product)) || 0) + (lines.find((l) => String(l.product) === String(i.product))?.quantity || 0) >= i.quantity);
  const othersLive = order.packages.some((p) => !p._id.equals(pkg._id) && p.status !== 'cancelled');
  const shippingRefund = completesPackage && !othersLive ? order.pricing.shipping : 0;
  const itemsAmount = round2(lines.reduce((s, l) => s + l.amount, 0));
  const vendorShare = round2(itemsAmount * (1 - pkg.commissionRate / 100));

  const ret = new Return({
    order: order._id,
    package: pkg._id,
    customer: user._id,
    vendor: pkg.vendor,
    items: lines,
    amount: round2(itemsAmount + shippingRefund),
    shippingRefund,
    vendorShare,
    reasonCode,
    note,
    photos,
  });
  push(ret, 'requested', 'customer', user._id, note);
  await ret.save();
  return ret;
}

/** Moves a return from one status to the next atomically, so a double click can't apply a step twice. */
async function step(returnId, from, to, { by, actorId, note, set = {} }) {
  const ret = await Return.findOneAndUpdate(
    { _id: returnId, status: { $in: [].concat(from) } },
    { $set: { status: to, ...set }, $push: { timeline: { status: to, by, actorId, note, at: new Date() } } },
    { new: true },
  );
  if (!ret) {
    const current = await Return.findById(returnId).select('status').lean();
    throw new ApiError(current ? 400 : 404, current ? `This return is ${current.status}` : 'Return not found');
  }
  return ret;
}

export const cancelReturn = (returnId, user) => step(returnId, 'requested', 'cancelled', { by: 'customer', actorId: user._id });

/** Vendor (or admin): approve or reject a requested return. */
export function decideReturn(returnId, actor, { action, note }) {
  return step(returnId, 'requested', action === 'approve' ? 'approved' : 'rejected', { ...actor, note, set: { vendorNote: note } });
}

/**
 * Vendor (or admin): the item came back and was inspected. Restock is optional (a damaged item isn't
 * put back on sale). Then the customer is refunded exactly what they paid for the returned units.
 */
export async function receiveReturn(returnId, actor, { restock, note }) {
  const ret = await step(returnId, 'approved', 'received', { ...actor, note, set: { restocked: Boolean(restock), vendorNote: note } });
  if (restock) {
    for (const item of ret.items) await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity, sold: -item.quantity } });
    await afterStockChange(ret.items);
  }
  return refundReturn(ret, actor);
}

/** Issues (or re-issues) the refund of a received return and completes it once the money is on its way. */
export async function refundReturn(ret, actor) {
  const order = await Order.findById(ret.order);
  const pkg = order.packages.id(ret.package);
  const refund = await issueRefund({ order, pkg, amount: ret.amount, reason: 'return', initiatedBy: { by: actor.by, actorId: actor.actorId }, returnRequest: ret._id });
  await Return.updateOne({ _id: ret._id }, { $set: { refund: refund._id } });
  settlePaymentStatus(order);
  await order.save();
  if (refund.status !== 'failed') await completeReturn(ret._id);
  return Return.findById(ret._id);
}

/**
 * received -> refunded, exactly once (also called when a failed refund is retried successfully).
 * The refunded amounts are added to the package, which lowers the vendor payout.
 */
export async function completeReturn(returnId) {
  const ret = await Return.findOneAndUpdate(
    { _id: returnId, status: 'received' },
    { $set: { status: 'refunded' }, $push: { timeline: { status: 'refunded', by: 'system', at: new Date() } } },
    { new: true },
  );
  if (!ret) return null;
  await Order.updateOne(
    { _id: ret.order, 'packages._id': ret.package },
    { $inc: { 'packages.$.returned.amount': ret.amount, 'packages.$.returned.vendorShare': ret.vendorShare } },
  );
  return ret;
}
