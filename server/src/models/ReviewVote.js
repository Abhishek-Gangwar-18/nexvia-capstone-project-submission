import mongoose from 'mongoose';

/** One "helpful" vote per customer per review; Review.helpfulCount mirrors the count with $inc. */
const reviewVoteSchema = new mongoose.Schema(
  {
    review: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

reviewVoteSchema.index({ review: 1, user: 1 }, { unique: true });

export const ReviewVote = mongoose.model('ReviewVote', reviewVoteSchema);
