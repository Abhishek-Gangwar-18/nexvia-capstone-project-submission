import mongoose from 'mongoose';

/**
 * A customer's star rating of a product: one per customer per product, only after a delivered purchase.
 * Product.rating / numRatings are kept in sync with $inc (services/reviews.js), never recounted on writes.
 * `user` is absent only on imported ratings (seed / pre-account data).
 */
const ratingSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    value: { type: Number, required: true, min: 1, max: 5, validate: { validator: Number.isInteger, message: 'Rating must be a whole number of stars' } },
  },
  { timestamps: true },
);

ratingSchema.index({ product: 1, user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });
// Star distribution on the product page.
ratingSchema.index({ product: 1, value: 1 });

export const Rating = mongoose.model('Rating', ratingSchema);
