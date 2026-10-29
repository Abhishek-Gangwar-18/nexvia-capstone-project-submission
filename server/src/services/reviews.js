import mongoose from 'mongoose';
import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { Rating } from '../models/Rating.js';
import { Review } from '../models/Review.js';
import { Vendor } from '../models/Vendor.js';
import { invalidateProducts } from './catalog.js';
import { indexProducts } from './search.js';
import { ApiError } from '../utils/http.js';

/** Ratings and reviews are for customers who received the product in a paid order. */
export async function hasDeliveredPurchase(userId, productId) {
  return Boolean(
    await Order.exists({
      customer: userId,
      'payment.status': 'paid',
      packages: { $elemMatch: { status: 'delivered', 'items.product': new mongoose.Types.ObjectId(String(productId)) } },
    }),
  );
}

export async function assertDeliveredPurchase(userId, productId) {
  if (!(await hasDeliveredPurchase(userId, productId))) {
    throw new ApiError(403, 'You can rate and review this product once an order with it has been delivered');
  }
}

/** Adds to a running rating total and recomputes the average in the same atomic update. */
const withAverage = (sum, count) => [
  { $set: { ratingSum: { $add: [{ $ifNull: ['$ratingSum', 0] }, sum] }, numRatings: { $add: [{ $ifNull: ['$numRatings', 0] }, count] } } },
  { $set: { rating: { $cond: [{ $gt: ['$numRatings', 0] }, { $round: [{ $divide: ['$ratingSum', '$numRatings'] }, 2] }, 0] } } },
];

/** Applies a rating change to the product and its store. O(1): no recount, safe under concurrent writes. */
async function applyRatingDelta(productId, sum, count) {
  if (!sum && !count) return;
  const product = await Product.findOneAndUpdate({ _id: productId }, withAverage(sum, count), { new: true, projection: { vendor: 1 } }).lean();
  if (!product) return;
  await Vendor.updateOne({ _id: product.vendor }, withAverage(sum, count));
  await invalidateProducts([product]);
  indexProducts([productId]);
}

/** Creates or changes the customer's single rating of a product. Returns the stored value. */
export async function setRating(userId, productId, value) {
  await assertDeliveredPurchase(userId, productId);
  let before;
  try {
    // returnDocument 'before': null means the rating was just created.
    before = await Rating.findOneAndUpdate({ product: productId, user: userId }, { $set: { value } }, { upsert: true, new: false, runValidators: true }).lean();
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Two first ratings raced on the unique index; the other one created it, so this is an update.
    before = await Rating.findOneAndUpdate({ product: productId, user: userId }, { $set: { value } }, { new: false, runValidators: true }).lean();
  }
  await applyRatingDelta(productId, value - (before?.value || 0), before ? 0 : 1);
  await Review.updateMany({ product: productId, user: userId }, { $set: { authorRating: value } });
  return value;
}

export async function removeRating(userId, productId) {
  const removed = await Rating.findOneAndDelete({ product: productId, user: userId }).lean();
  if (!removed) return;
  await applyRatingDelta(productId, -removed.value, -1);
  await Review.updateMany({ product: productId, user: userId }, { $set: { authorRating: null } });
}

/** Reviews carry the author's current name; imported reviews without an account keep their stored one. */
export const authorName = (review) => review.user?.name || review.authorName || 'Vendora customer';
