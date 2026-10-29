import { env, isProd } from '../config/env.js';
import { REFRESH_COOKIE } from '../services/session.js';

/** Minimal cookie header parser (only the refresh cookie is ever read). */
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
