import mongoose from 'mongoose';

export const REVOKE_REASONS = ['logout', 'logout_all', 'revoked', 'password_change', 'blocked', 'reuse_detected'];

/**
 * One signed-in device. A request is accepted only while its session exists and is not revoked
 * (an allowlist, so a lost cache entry means "check MongoDB", never "let it through").
 *
 * The refresh token is `<sessionId>.<secret>`; only the SHA-256 of the current secret is stored and it
 * rotates on every refresh. `previousTokenHash` catches a replayed (stolen) old refresh token.
 */
const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    refreshTokenHash: { type: String, required: true, select: false },
    previousTokenHash: { type: String, select: false },
    rotatedAt: Date,
    userAgent: { type: String, maxlength: 300 },
    ip: String,
    lastUsedAt: { type: Date, default: Date.now },
    /** Sliding expiry (idle limit), never later than maxExpiresAt. */
    expiresAt: { type: Date, required: true },
    maxExpiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, enum: REVOKE_REASONS },
  },
  { timestamps: true },
);

// "My devices" and "log out everywhere".
sessionSchema.index({ user: 1, revokedAt: 1, lastUsedAt: -1 });
// MongoDB deletes sessions once they can no longer be refreshed (revoked ones stay until then, for the audit trail).
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
