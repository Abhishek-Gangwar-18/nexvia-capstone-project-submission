import mongoose from 'mongoose';

/**
 * Durable record of logged-out sessions. Redis/the in-memory cache serves the per-request check;
 * this collection survives restarts, and MongoDB's TTL monitor deletes entries once the JWT would have expired.
 */
const revokedSessionSchema = new mongoose.Schema(
  {
    sid: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

revokedSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RevokedSession = mongoose.model('RevokedSession', revokedSessionSchema);
