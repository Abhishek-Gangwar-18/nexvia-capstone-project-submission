import mongoose from 'mongoose';
import { z } from 'zod';
import { Return, RETURN_REASONS, RETURN_STATUSES } from '../models/Return.js';
import { cancelReturn, decideReturn, receiveReturn, refundReturn, requestReturn } from '../services/returns.js';
import { retryRefund } from '../services/refunds.js';
import { ApiError, paginated, parsePagination } from '../utils/http.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const photo = z.object({ url: z.string().url() });

export const returnRequestSchema = z
  .object({
    packageId: objectId,
    items: z.array(z.object({ product: objectId, quantity: z.coerce.number().int().min(1).max(10) })).min(1, 'Choose at least one item').max(20),
    reasonCode: z.enum(RETURN_REASONS),
    note: z.string().trim().max(500).optional(),
    photos: z.array(photo).max(5).optional().default([]),
  })
  .refine((b) => b.reasonCode !== 'other' || (b.note && b.note.length >= 3), { message: 'Describe the problem (at least 3 characters)', path: ['note'] });

export const returnDecisionSchema = z
  .object({ action: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() })
  .refine((b) => b.action !== 'reject' || (b.note && b.note.length >= 3), { message: 'Give the customer a reason for rejecting', path: ['note'] });

export const returnReceiveSchema = z.object({ restock: z.boolean(), note: z.string().trim().max(500).optional() });

function returnId(req) {
  if (!mongoose.isValidObjectId(req.params.returnId)) throw new ApiError(400, 'Invalid return id');
  return req.params.returnId;
}

const listQuery = (req, base) => {
  const filter = { ...base };
  if (RETURN_STATUSES.includes(req.query.status)) filter.status = req.query.status;
  return filter;
};

async function list(req, res, base, populate = []) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 10 });
  const filter = listQuery(req, base);
  let query = Return.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
  for (const p of populate) query = query.populate(...p);
  const [items, total] = await Promise.all([query.lean(), Return.countDocuments(filter)]);
  res.json(paginated(items, total, page, limit));
}

/* ------------------------------------------------------------ customers */

export async function createReturn(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid order id');
  res.status(201).json({ return: await requestReturn(req.user, req.params.id, req.body) });
}

/** Returns of one order (customer: own orders only). */
export async function orderReturns(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid order id');
  res.json({ returns: await Return.find({ order: req.params.id, customer: req.user._id }).sort({ createdAt: -1 }).lean() });
}

export async function myReturns(req, res) {
  return list(req, res, { customer: req.user._id });
}

export async function withdrawReturn(req, res) {
  const ret = await Return.findOne({ _id: returnId(req), customer: req.user._id }).select('_id').lean();
  if (!ret) throw new ApiError(404, 'Return not found');
  res.json({ return: await cancelReturn(ret._id, req.user) });
}

/* -------------------------------------------------------------- vendors */

export async function vendorReturns(req, res) {
  return list(req, res, { vendor: req.vendor._id }, [['customer', 'name']]);
}

async function vendorsReturn(req) {
  const ret = await Return.findOne({ _id: returnId(req), vendor: req.vendor._id }).select('_id').lean();
  if (!ret) throw new ApiError(404, 'Return not found');
  return ret._id;
}

const actorOf = (req) => ({ by: req.user.role === 'admin' ? 'admin' : 'vendor', actorId: req.user._id });

export async function vendorDecide(req, res) {
  res.json({ return: await decideReturn(await vendorsReturn(req), actorOf(req), req.body) });
}

export async function vendorReceive(req, res) {
  res.json({ return: await receiveReturn(await vendorsReturn(req), actorOf(req), req.body) });
}

/* ---------------------------------------------------------------- admin */

/** All returns; the admin oversees and can take any step for the vendor. */
export async function adminReturns(req, res) {
  return list(req, res, {}, [['customer', 'name email'], ['vendor', 'storeName']]);
}

export async function adminDecide(req, res) {
  res.json({ return: await decideReturn(returnId(req), actorOf(req), req.body) });
}

export async function adminReceive(req, res) {
  res.json({ return: await receiveReturn(returnId(req), actorOf(req), req.body) });
}

/**
 * Retries the refund of a received return. An existing (failed) refund is retried, never replaced, so an
 * attempt that secretly went through at Stripe is found instead of refunding twice.
 */
export async function adminRefundReturn(req, res) {
  const ret = await Return.findById(returnId(req));
  if (!ret) throw new ApiError(404, 'Return not found');
  if (ret.status !== 'received') throw new ApiError(400, `This return is ${ret.status}`);
  if (ret.refund) {
    await retryRefund(ret.refund);
    return res.json({ return: await Return.findById(ret._id) });
  }
  return res.json({ return: await refundReturn(ret, actorOf(req)) });
}
