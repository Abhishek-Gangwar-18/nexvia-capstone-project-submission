import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.ts';
import { User } from '../models/User.ts';
import { Session } from '../models/Session.ts';
import { cache } from './cache.ts';
import { ApiError } from '../utils/http.ts';

const DAY = 24 * 60 * 60 * 1000;
const USER_TTL = 15 * 60;
/** How long a "this session is active" answer is cached; revocation deletes it at once. */
const SESSION_CACHE_TTL = 60;
/** Two tabs refreshing at the same moment: the slower one presents the token the faster one just rotated. */
const ROTATION_GRACE_MS = 30 * 1000;

const userKey = (id) => `user:${id}`;
const sessionKey = (sid) => `session:${sid}`;
const hash = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
const newSecret = () => crypto.randomBytes(32).toString('hex');

export const REFRESH_COOKIE = 'vendora_rt';

/**
 * 403 for a blocked account, with the admin's reason for the blocked screen. The error handler also
 * marks the browser as blocked (blockedUserId), so the rest of the site stays closed to it.
 */
export function accountBlocked(user) {
  const err = new ApiError(403, 'Your account has been blocked. Please contact support.', {
    code: 'ACCOUNT_BLOCKED',
    reason: user.blockedReason || null,
    blockedAt: user.blockedAt || null,
  });
  (err as ApiError & { blockedUserId?: string }).blockedUserId = String(user._id);
  return err;
}

/** Short-lived JWT for the Authorization header. */
function signAccessToken(user, sid) {
  return jwt.sign({ sub: String(user._id), role: user.role, sid: String(sid) }, env.jwtSecret, { expiresIn: env.accessTokenTtl as jwt.SignOptions['expiresIn'] });
}

const idleExpiry = (session, now = Date.now()) => new Date(Math.min(now + env.refreshIdleDays * DAY, session.maxExpiresAt.getTime()));

/**
 * Starts a session for a device. Returns the access token, the refresh token (for the cookie) and its expiry.
 */
export async function createSession(user, req) {
  const secret = newSecret();
  const now = Date.now();
  const maxExpiresAt = new Date(now + env.sessionMaxDays * DAY);
  const session = await Session.create({
    user: user._id,
    refreshTokenHash: hash(secret),
    userAgent: req?.get?.('user-agent')?.slice(0, 300),
    ip: req?.ip,
    maxExpiresAt,
    expiresAt: new Date(Math.min(now + env.refreshIdleDays * DAY, maxExpiresAt.getTime())),
  });
  await cache.setJSON(userKey(user._id), user.toSafeJSON(), USER_TTL);
  return { accessToken: signAccessToken(user, session._id), refreshToken: `${session._id}.${secret}`, refreshExpiresAt: session.expiresAt };
}

/**
 * Exchanges a refresh token for a new access token and rotates the refresh token (atomic: one winner).
 * A replayed old token outside the grace window means it was copied - the whole session is revoked.
 * Returns { accessToken, refreshToken?, refreshExpiresAt?, user }; refreshToken is absent when the
 * request lost a benign race with another tab (the browser already holds the newer cookie).
 */
export async function refreshSession(refreshToken) {
  const [sid, secret] = String(refreshToken || '').split('.');
  if (!secret || !/^[a-f\d]{24}$/i.test(sid)) throw new ApiError(401, 'Please log in to continue', { code: 'NO_SESSION' });
  const now = new Date();
  const presented = hash(secret);
  const live = { _id: sid, revokedAt: null, expiresAt: { $gt: now } };

  const current = await Session.findOne(live).select('+refreshTokenHash +previousTokenHash maxExpiresAt rotatedAt user').lean();
  if (!current) {
    const owner = await blockedOwner({ _id: sid, $or: [{ refreshTokenHash: presented }, { previousTokenHash: presented }] });
    if (owner) throw accountBlocked(owner);
    throw new ApiError(401, 'Your session has ended. Please log in again.', { code: 'NO_SESSION' });
  }

  const user = await User.findById(current.user);
  if (!user) throw new ApiError(401, 'Your session has ended. Please log in again.', { code: 'NO_SESSION' });
  if (user.status === 'blocked') {
    await revokeSessions({ _id: sid }, 'blocked');
    throw accountBlocked(user);
  }

  const nextSecret = newSecret();
  const rotated = await Session.findOneAndUpdate(
    { ...live, refreshTokenHash: presented },
    { $set: { refreshTokenHash: hash(nextSecret), previousTokenHash: presented, rotatedAt: now, lastUsedAt: now, expiresAt: idleExpiry(current, now.getTime()) } },
    { new: true },
  ).lean();
  if (rotated) {
    return { accessToken: signAccessToken(user, sid), refreshToken: `${sid}.${nextSecret}`, refreshExpiresAt: rotated.expiresAt, user };
  }

  // Not the current token. The one just rotated away, within seconds -> a parallel refresh: no new cookie.
  if (presented === current.previousTokenHash && current.rotatedAt && +now - +current.rotatedAt < ROTATION_GRACE_MS) {
    return { accessToken: signAccessToken(user, sid), user };
  }
  // Anything else is a reused (stolen) token: end the session for both the thief and the owner.
  await revokeSessions({ _id: sid }, 'reuse_detected');
  throw new ApiError(401, 'Your session has ended for security reasons. Please log in again.', { code: 'NO_SESSION' });
}

/**
 * The still-blocked owner of a session the block ended, or null: its holder is told the account is blocked
 * instead of "log in again". Read from MongoDB, never the profile cache, which a request racing the block
 * may have refilled with the profile from before it.
 */
async function blockedOwner(filter) {
  const ended = await Session.findOne({ ...filter, revokedReason: 'blocked' }).select('user').lean();
  const user = ended && (await User.findById(ended.user));
  return user?.status === 'blocked' ? user : null;
}

/** For a signed access token whose session has ended. */
export const blockedSessionOwner = (sid) => blockedOwner({ _id: sid });

/** Is this session still allowed? Cached briefly; a miss reads MongoDB (fails closed). */
export async function isSessionActive(sid) {
  if (!/^[a-f\d]{24}$/i.test(String(sid))) return false;
  if (await cache.exists(sessionKey(sid))) return true;
  const active = await Session.exists({ _id: sid, revokedAt: null, expiresAt: { $gt: new Date() } });
  if (active) await cache.set(sessionKey(sid), '1', SESSION_CACHE_TTL);
  return Boolean(active);
}

/** Revokes every live session matching the filter and drops their cache entries. Returns how many. */
async function revokeSessions(filter, reason) {
  const live = { ...filter, revokedAt: null };
  const ids = await Session.find(live).distinct('_id');
  if (!ids.length) return 0;
  await Session.updateMany({ _id: { $in: ids }, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  await cache.del(...ids.map((id) => sessionKey(id)));
  return ids.length;
}

export const revokeSession = (sid, reason = 'logout') => revokeSessions({ _id: sid }, reason);
export const revokeUserSession = (userId, sid) => revokeSessions({ _id: sid, user: userId }, 'revoked');

/** Logs a user out everywhere, optionally keeping one session (e.g. the device that changed the password). */
export function revokeAllSessions(userId, reason = 'logout_all', { except }: Record<string, any> = {}) {
  return revokeSessions({ user: userId, ...(except ? { _id: { $ne: except } } : {}) }, reason);
}

/** The user's signed-in devices, newest activity first. */
export function listSessions(userId) {
  return Session.find({ user: userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastUsedAt: -1 })
    .select('userAgent ip createdAt lastUsedAt expiresAt')
    .lean();
}

/** Logout from the refresh cookie alone (works even after the access token expired). Needs the real secret. */
export async function revokeByRefreshToken(refreshToken) {
  const [sid, secret] = String(refreshToken || '').split('.');
  if (!secret || !/^[a-f\d]{24}$/i.test(sid)) return 0;
  const presented = hash(secret);
  return revokeSessions({ _id: sid, $or: [{ refreshTokenHash: presented }, { previousTokenHash: presented }] }, 'logout');
}

export async function loadSessionUser(id) {
  return cache.remember(userKey(id), USER_TTL, async () => {
    const user = await User.findById(id);
    return user ? user.toSafeJSON() : null;
  });
}

export const invalidateUser = (id) => cache.del(userKey(id));
