import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Vendor } from '../models/Vendor.js';
import { accountBlocked, blockedSessionOwner, isSessionActive, loadSessionUser } from '../services/session.js';
import { BLOCKED_COOKIE, clearBlockedCookie, readBlockedCookie, readCookie } from '../utils/cookies.js';
import { ApiError, asyncHandler } from '../utils/http.js';

/**
 * Requires a valid access token (Bearer) whose session is still active. Sets req.user and req.auth.
 * 401 codes tell the client what to do: TOKEN_EXPIRED -> call /auth/refresh and retry; anything else -> log in.
 */
export const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new ApiError(401, 'Please log in to continue');

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new ApiError(401, 'Access token expired', { code: 'TOKEN_EXPIRED' });
    throw new ApiError(401, 'Please log in to continue', { code: 'INVALID_TOKEN' });
  }

  const user = await loadSessionUser(payload.sub);
  if (!user) throw new ApiError(401, 'Account not found');
  // Before the session check: blocking ends every session, and the browser should be told why.
  if (user.status === 'blocked') throw accountBlocked(user);
  if (!(await isSessionActive(payload.sid))) {
    const owner = await blockedSessionOwner(payload.sid);
    if (owner) throw accountBlocked(owner);
    throw new ApiError(401, 'You have been logged out. Please log in again.', { code: 'SESSION_ENDED' });
  }
  // Tokens issued before the last password change are no longer valid.
  if (user.passwordChangedAt && payload.iat < Math.floor(new Date(user.passwordChangedAt).getTime() / 1000)) {
    throw new ApiError(401, 'Your password was changed. Please log in again.', { code: 'SESSION_ENDED' });
  }

  req.user = user;
  req.auth = payload;
  // Tells the client this answer just proved its session active, so it can skip a separate GET /auth/status.
  res.set('X-Session', 'active');
  next();
});

/** Attaches req.user when a valid token is present; only a blocked account is rejected. */
export const optionalAuth = (req, res, next) => {
  if (!req.headers.authorization) return next();
  return protect(req, res, (err) => {
    if (err?.blockedUserId) return next(err);
    if (err) req.user = undefined;
    next();
  });
};

// What a blocked browser can still do: sign in with another account, and log out.
const OPEN_WHILE_BLOCKED = new Set(['POST /auth/login', 'POST /auth/logout']);

/** The account of a browser marked as blocked, while it still is; the mark is dropped once it isn't. */
async function markedAccount(req, res) {
  if (!readCookie(req, BLOCKED_COOKIE)) return null;
  const userId = readBlockedCookie(req);
  const user = userId ? await loadSessionUser(userId) : null;
  if (user?.status === 'blocked') return user;
  clearBlockedCookie(res);
  return null;
}

/**
 * The blocked account a Bearer token belongs to, or null. Expired tokens count too: this only ever
 * refuses, and a tab left open past the token's 15 minutes must not keep browsing the public pages.
 */
async function tokenAccount(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  let payload;
  try {
    payload = jwt.verify(header.slice(7), env.jwtSecret, { ignoreExpiration: true });
  } catch {
    return null;
  }
  const user = await loadSessionUser(payload.sub);
  return user?.status === 'blocked' ? user : null;
}

/**
 * Runs before every route, public catalog included: a blocked account's token, or a browser marked as
 * used by one (utils/cookies.js), gets 403 ACCOUNT_BLOCKED from the whole API until an admin unblocks
 * the account or someone signs in there with an account that isn't blocked.
 */
export const blockedGuard = asyncHandler(async (req, res, next) => {
  const user = (await markedAccount(req, res)) || (await tokenAccount(req));
  if (!user || OPEN_WHILE_BLOCKED.has(`${req.method} ${req.path}`)) return next();
  throw accountBlocked(user);
});

/** Role-based access control. */
export const authorize = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new ApiError(403, 'You do not have permission to perform this action'));
  }
  return next();
};

/** Loads the vendor profile for the logged-in vendor. With `approved`, blocks stores that are not live yet. */
export const loadVendor = ({ approved = true } = {}) =>
  asyncHandler(async (req, _res, next) => {
    const vendor = await Vendor.findOne({ user: req.user._id });
    if (!vendor) throw new ApiError(403, 'Please complete seller onboarding first', { code: 'VENDOR_ONBOARDING_REQUIRED' });
    if (approved && vendor.status !== 'approved') {
      throw new ApiError(403, `Your store is ${vendor.status}. You can manage it once an admin approves it.`, {
        code: 'VENDOR_NOT_APPROVED',
        status: vendor.status,
      });
    }
    req.vendor = vendor;
    next();
  });
