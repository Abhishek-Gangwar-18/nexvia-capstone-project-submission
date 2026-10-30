import mongoose from 'mongoose';
import { z } from 'zod';
import { Product } from '../models/Product.js';
import { Rating } from '../models/Rating.js';
import { Review, REVIEW_LIMITS } from '../models/Review.js';
import { ReviewVote } from '../models/ReviewVote.js';
import { assertDeliveredPurchase, authorName, hasDeliveredPurchase, removeRating, setRating } from '../services/reviews.js';
import { deleteReplaced } from '../services/storage.js';
import { ApiError, paginated, parsePagination } from '../utils/http.js';

const L = REVIEW_LIMITS;
const photo = z.object({ url: z.string().url() });

export const ratingSchema = z.object({ value: z.coerce.number().int().min(1, 'Pick a star rating').max(5) });
export const reviewSchema = z.object({
  title: z.string().trim().max(L.title).optional().default(''),
  comment: z.string().trim().min(L.commentMin, `Tell others a little more (at least ${L.commentMin} characters)`).max(L.comment),
  photos: z.array(photo).max(L.photos, `Up to ${L.photos} photos`).optional().default([]),
});
export const reviewUpdateSchema = reviewSchema.partial().refine((b) => Object.keys(b).length > 0, 'Send at least one field to update');
export const replySchema = z.object({ text: z.string().trim().min(2, 'Write a reply').max(L.reply) });
export const moderationSchema = z
  .object({ status: z.enum(['visible', 'hidden']), reason: z.string().trim().max(200).optional() })
  .refine((b) => b.status !== 'hidden' || (b.reason && b.reason.length >= 3), { message: 'A reason is required to hide a review', path: ['reason'] });

const SORTS = {
  recent: { createdAt: -1 },
  top: { authorRating: -1, createdAt: -1 },
  low: { authorRating: 1, createdAt: -1 },
  helpful: { helpfulCount: -1, createdAt: -1 },
};

/** Public shape: the author's current name, never their user document. */
const toPublic = (r) => ({ ...r, user: r.user?._id || r.user || null, name: authorName(r) });

function productIdOf(req) {
  const { productId } = req.params;
  if (!mongoose.isValidObjectId(productId)) throw new ApiError(400, 'Invalid product id');
  return productId;
}

async function existingProduct(productId) {
  const product = await Product.findById(productId).select('_id vendor').lean();
  if (!product) throw new ApiError(404, 'Product not found');
  return product;
}

/* ------------------------------------------------------------ shoppers */

/** Visible reviews of a product, the star distribution (from ratings) and what the viewer can do. */
export async function listReviews(req, res) {
  const productId = productIdOf(req);
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 6, maxLimit: 30 });
  const filter = { product: productId, 'moderation.status': 'visible' };
  if (req.query.rating) filter.authorRating = Number(req.query.rating);

  const userId = req.user?._id;
  const [items, total, breakdown, myRating, myReviews, canReview] = await Promise.all([
    Review.find(filter).sort(SORTS[req.query.sort] || SORTS.recent).skip(skip).limit(limit).populate('user', 'name').lean(),
    Review.countDocuments(filter),
    Rating.aggregate([{ $match: { product: new mongoose.Types.ObjectId(productId) } }, { $group: { _id: '$value', count: { $sum: 1 } } }]),
    userId ? Rating.findOne({ product: productId, user: userId }).select('value').lean() : null,
    userId ? Review.find({ product: productId, user: userId }).select('_id').lean() : [],
    userId ? hasDeliveredPurchase(userId, productId) : false,
  ]);
  const votes = userId ? await ReviewVote.find({ user: userId, review: { $in: items.map((r) => r._id) } }).select('review').lean() : [];

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  breakdown.forEach((b) => {
    distribution[b._id] = b.count;
  });
  res.json({
    ...paginated(items.map(toPublic), total, page, limit),
    distribution,
    myRating: myRating?.value || null,
    myReviewIds: myReviews.map((r) => String(r._id)),
    myVotes: votes.map((v) => String(v.review)),
    canReview,
    reviewsLeft: Math.max(0, L.perUser - myReviews.length),
  });
}

/** PUT /products/:productId/rating - one rating per customer, changeable any time. */
export async function rateProduct(req, res) {
  const productId = productIdOf(req);
  await existingProduct(productId);
  const value = await setRating(req.user._id, productId, req.body.value);
  res.json({ rating: value });
}

export async function unrateProduct(req, res) {
  await removeRating(req.user._id, productIdOf(req));
  res.json({ rating: null });
}

/** Written reviews: unlimited in spirit, capped at 20 per customer per product. */
export async function createReview(req, res) {
  const productId = productIdOf(req);
  const product = await existingProduct(productId);
  await assertDeliveredPurchase(req.user._id, productId);
  if ((await Review.countDocuments({ product: productId, user: req.user._id })) >= L.perUser) {
    throw new ApiError(400, `You can write up to ${L.perUser} reviews for one product`);
  }
  const rating = await Rating.findOne({ product: productId, user: req.user._id }).select('value').lean();
  const review = await Review.create({ ...req.body, product: product._id, user: req.user._id, authorRating: rating?.value ?? null, verified: true });
  res.status(201).json({ review: toPublic({ ...review.toObject(), user: { _id: req.user._id, name: req.user.name } }) });
}

async function authoredReview(req, { allowAdmin = false } = {}) {
  const { reviewId } = req.params;
  if (!mongoose.isValidObjectId(reviewId)) throw new ApiError(400, 'Invalid review id');
  const review = await Review.findOne({ _id: reviewId, product: productIdOf(req) });
  if (!review) throw new ApiError(404, 'Review not found');
  const isAuthor = String(review.user) === String(req.user._id);
  if (!isAuthor && !(allowAdmin && req.user.role === 'admin')) throw new ApiError(403, 'You can only change your own reviews');
  return review;
}

const photoUrls = (photos) => (photos || []).map((p) => p.url);

export async function updateReview(req, res) {
  const review = await authoredReview(req);
  const before = photoUrls(review.photos);
  Object.assign(review, req.body);
  await review.save();
  deleteReplaced(before, photoUrls(review.photos), review.user);
  res.json({ review: toPublic({ ...review.toObject(), user: { _id: req.user._id, name: req.user.name } }) });
}

export async function deleteReview(req, res) {
  const review = await authoredReview(req, { allowAdmin: true });
  await review.deleteOne();
  await ReviewVote.deleteMany({ review: review._id });
  deleteReplaced(photoUrls(review.photos), [], review.user);
  res.json({ message: 'Review deleted' });
}

/** "Helpful" vote: once per customer per review, never on your own review. */
export async function voteHelpful(req, res) {
  const review = await Review.findOne({ _id: req.params.reviewId, product: productIdOf(req), 'moderation.status': 'visible' }).select('user').lean();
  if (!review) throw new ApiError(404, 'Review not found');
  if (String(review.user) === String(req.user._id)) throw new ApiError(400, "You can't vote on your own review");
  try {
    await ReviewVote.create({ review: review._id, user: req.user._id });
    await Review.updateOne({ _id: review._id }, { $inc: { helpfulCount: 1 } });
  } catch (err) {
    if (err.code !== 11000) throw err; // already voted: nothing changes
  }
  res.json({ helpful: true });
}

export async function unvoteHelpful(req, res) {
  const removed = await ReviewVote.findOneAndDelete({ review: req.params.reviewId, user: req.user._id });
  if (removed) await Review.updateOne({ _id: removed.review, helpfulCount: { $gt: 0 } }, { $inc: { helpfulCount: -1 } });
  res.json({ helpful: false });
}

/* -------------------------------------------------------------- sellers */

/** Reviews on the seller's own products (?replied=yes|no, ?product=id). */
export async function vendorReviews(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 10 });
  const productIds = await Product.find({ vendor: req.vendor._id }).distinct('_id');
  const filter = { product: { $in: productIds }, 'moderation.status': 'visible' };
  if (mongoose.isValidObjectId(req.query.product)) filter.product = req.query.product;
  if (req.query.replied === 'yes') filter['reply.text'] = { $exists: true };
  if (req.query.replied === 'no') filter['reply.text'] = { $exists: false };
  const [items, total] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name').populate('product', 'title thumbnail').lean(),
    Review.countDocuments(filter),
  ]);
  res.json(paginated(items.map(toPublic), total, page, limit));
}

async function vendorsReview(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid review id');
  const review = await Review.findById(req.params.id);
  if (!review) throw new ApiError(404, 'Review not found');
  if (!(await Product.exists({ _id: review.product, vendor: req.vendor._id }))) throw new ApiError(404, 'Review not found');
  return review;
}

/** One public reply per review; sending again edits it. */
export async function replyToReview(req, res) {
  const review = await vendorsReview(req);
  review.reply = { text: req.body.text, by: req.user._id, at: new Date() };
  await review.save();
  res.json({ reply: review.reply });
}

export async function deleteReply(req, res) {
  const review = await vendorsReview(req);
  review.reply = undefined;
  await review.save();
  res.json({ reply: null });
}

/* ---------------------------------------------------------------- admin */

/** Moderation queue: ?status=visible|hidden, ?q= text in title/comment. */
export async function adminReviews(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20 });
  const filter = {};
  if (['visible', 'hidden'].includes(req.query.status)) filter['moderation.status'] = req.query.status;
  if (mongoose.isValidObjectId(req.query.product)) filter.product = req.query.product;
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60), 'i');
    filter.$or = [{ title: rx }, { comment: rx }];
  }
  const [items, total] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name email').populate('product', 'title thumbnail').lean(),
    Review.countDocuments(filter),
  ]);
  res.json(paginated(items.map((r) => ({ ...toPublic(r), email: r.user?.email })), total, page, limit));
}

/** Hide or restore a review (it stays on record either way). Ratings are separate and unaffected. */
export async function moderateReview(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid review id');
  const review = await Review.findById(req.params.id);
  if (!review) throw new ApiError(404, 'Review not found');
  review.moderation = { status: req.body.status, reason: req.body.status === 'hidden' ? req.body.reason : undefined, by: req.user._id, at: new Date() };
  await review.save();
  res.json({ review });
}
