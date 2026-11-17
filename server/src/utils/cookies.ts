import jwt from 'jsonwebtoken';
import { env, isProd } from '../config/env.ts';
import { REFRESH_COOKIE } from '../services/session.ts';

export const BLOCKED_COOKIE = 'vendora_blocked';
const BLOCKED_DAYS = 30;

/** Minimal cookie header parser (only the refresh and blocked cookies are ever read). */
export function readCookie(req, name) {
  const pair = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

// Sent only to the auth routes, never readable from JavaScript.
const base = () => ({
  httpOnly: true,
  secure: isProd || env.cookieSameSite === 'none',
  sameSite: env.cookieSameSite,
  path: '/auth',
});

export const readRefreshCookie = (req) => readCookie(req, REFRESH_COOKIE);
export const setRefreshCookie = (res, token, expiresAt) => res.cookie(REFRESH_COOKIE, token, { ...base(), expires: expiresAt });
export const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE, base());

/**
 * Marks this browser as used by a blocked account: sent with every API request, so the whole API stays
 * closed to it (middleware/auth.ts blockedGuard). Signed, and typed so an access token can't pass as one.
 */
export function setBlockedCookie(res, userId) {
  const token = jwt.sign({ sub: String(userId), typ: 'blocked' }, env.jwtSecret, { expiresIn: `${BLOCKED_DAYS}d` });
  res.cookie(BLOCKED_COOKIE, token, { ...base(), path: '/', maxAge: BLOCKED_DAYS * 24 * 60 * 60 * 1000 });
}
export const clearBlockedCookie = (res) => res.clearCookie(BLOCKED_COOKIE, { ...base(), path: '/' });

/** The blocked user's id, or null when the cookie is missing, expired or forged. */
export function readBlockedCookie(req) {
  const token = readCookie(req, BLOCKED_COOKIE);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    return typeof payload !== 'string' && payload.typ === 'blocked' ? payload.sub : null;
  } catch {
    return null;
  }
}
