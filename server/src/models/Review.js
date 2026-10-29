import mongoose from 'mongoose';

/** Limits shared by the schema and the Zod rules in catalog.controller.js. */
export const REVIEW_LIMITS = { title: 100, commentMin: 10, comment: 2000, photos: 5, perUser: 20, reply: 1000 };

/**
 * A written review (comment). Stars live in Rating; `authorRating` is a copy of the author's current
 * rating so the list can be filtered and sorted by stars (updated whenever the author re-rates).
 */
const reviewSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    /** Absent only on imported reviews; the shown name always comes from the user's current profile. */
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /** Name for imported reviews that have no account. */
    authorName: { type: String, trim: true },
    authorRating: { type: Number, min: 1, max: 5, default: null },
    title: { type: String, trim: true, default: '', maxlength: REVIEW_LIMITS.title },
    comment: { type: String, trim: true, required: true, minlength: REVIEW_LIMITS.commentMin, maxlength: REVIEW_LIMITS.comment },
    photos: {
      type: [{ url: { type: String, required: true }, key: String, _id: false }],
      validate: { validator: (v) => v.length <= REVIEW_LIMITS.photos, message: `Up to ${REVIEW_LIMITS.photos} photos allowed` },
    },
    verified: { type: Boolean, default: false },
    helpfulCount: { type: Number, default: 0, min: 0 },
    /** The seller's public answer (one per review). */
    reply: {
      text: { type: String, trim: true, maxlength: REVIEW_LIMITS.reply },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
    },
    /** Admin moderation: hidden reviews stay on record but are not shown to shoppers. */
    moderation: {
      status: { type: String, enum: ['visible', 'hidden'], default: 'visible' },
      reason: String,
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
    },
  },
  { timestamps: true },
);

// Product page: visible reviews, newest / by stars / most helpful.
reviewSchema.index({ product: 1, 'moderation.status': 1, createdAt: -1 });
reviewSchema.index({ product: 1, 'moderation.status': 1, authorRating: -1, createdAt: -1 });
reviewSchema.index({ product: 1, 'moderation.status': 1, helpfulCount: -1, createdAt: -1 });
// "My reviews" on a product and the 20-per-product limit.
reviewSchema.index({ product: 1, user: 1 });
// Admin moderation queue.
reviewSchema.index({ 'moderation.status': 1, createdAt: -1 });

export const Review = mongoose.model('Review', reviewSchema);
