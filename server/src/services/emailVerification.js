import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { sendVerificationEmail } from './mail.js';
import { invalidateUser } from './session.js';
import { logger } from '../utils/logger.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Issues a fresh single-use token (replacing any older one) and emails the verification link. */
export async function issueVerification(user) {
  const token = crypto.randomBytes(32).toString('hex');
  await User.updateOne(
    { _id: user._id },
    { emailVerifyTokenHash: hashToken(token), emailVerifyExpires: new Date(Date.now() + TOKEN_TTL_MS) },
  );
  const link = `${env.clientUrls[0]}/verify-email?token=${token}`;
  try {
    await sendVerificationEmail(user.email, user.name, link);
  } catch (err) {
    // Registration must not fail because the mail provider is down; the user can resend.
    logger.error('[mail] verification email failed:', err.message);
  }
}

/** Marks the matching account verified. Returns the user, or null for an unknown/expired token. */
export async function confirmVerification(token) {
  const user = await User.findOneAndUpdate(
    { emailVerifyTokenHash: hashToken(token), emailVerifyExpires: { $gt: new Date() } },
    { $set: { emailVerified: true }, $unset: { emailVerifyTokenHash: 1, emailVerifyExpires: 1 } },
    { new: true },
  );
  if (user) await invalidateUser(user._id);
  return user;
}
