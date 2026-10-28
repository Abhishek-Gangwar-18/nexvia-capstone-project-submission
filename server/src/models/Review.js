import mongoose from 'mongoose';

const reviewSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: { type: String, required: true, trim: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, trim: true, default: '' },
    comment: { type: String, trim: true, default: '' },
    verified: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// A user may review the same product more than once; this index only speeds up "my reviews" lookups.
reviewSchema.index({ product: 1, user: 1 });

export const Review = mongoose.model('Review', reviewSchema);
