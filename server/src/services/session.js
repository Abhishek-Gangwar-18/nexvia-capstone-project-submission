import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { RevokedSession } from '../models/RevokedSession.js';
import { cache } from './cache.js';

const USER_TTL = 15 * 60;
const userKey = (id) => `user:${id}`;

/**
 * Issues a JWT carrying the user id, role and a session id (sid).
 * The user profile is cached in Redis so authenticated requests don't hit MongoDB,
 * and logout revokes the sid in Redis so the token stops working immediately.
 */
export async function createSession(user) {
  const sid = crypto.randomUUID();
  const token = jwt.sign({ sub: user._id.toString(), role: user.role, sid }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
  await cache.setJSON(userKey(user._id), user.toSafeJSON(), USER_TTL);
  return token;
}

/** Revokes a session in the cache (fast per-request check) and in MongoDB (survives restarts). */
export async function revokeSession(payload) {
  const ttl = payload.exp - Math.floor(Date.now() / 1000);
  if (ttl <= 0) return;
  await cache.set(`revoked:${payload.sid}`, '1', ttl);
  await RevokedSession.updateOne(
    { sid: payload.sid },
    { $setOnInsert: { sid: payload.sid, user: payload.sub, expiresAt: new Date(payload.exp * 1000) } },
    { upsert: true },
  );
}

export const isRevoked = (sid) => cache.exists(`revoked:${sid}`);

/** Reloads still-valid revocations from MongoDB into the cache at startup (the in-memory cache starts empty). */
export async function restoreRevokedSessions() {
  const now = Date.now();
  const revoked = await RevokedSession.find({ expiresAt: { $gt: new Date(now) } }).select('sid expiresAt').lean();
  await Promise.all(revoked.map((r) => cache.set(`revoked:${r.sid}`, '1', Math.ceil((r.expiresAt.getTime() - now) / 1000))));
  return revoked.length;
}

export async function loadSessionUser(id) {
  return cache.remember(userKey(id), USER_TTL, async () => {
    const user = await User.findById(id);
    return user ? user.toSafeJSON() : null;
  });
}

export const invalidateUser = (id) => cache.del(userKey(id));
