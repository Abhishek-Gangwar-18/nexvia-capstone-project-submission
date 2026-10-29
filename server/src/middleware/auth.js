import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Vendor } from '../models/Vendor.js';
import { isSessionActive, loadSessionUser } from '../services/session.js';
import { ApiError, asyncHandler } from '../utils/http.js';

/**
 * Requires a valid access token (Bearer) whose session is still active. Sets req.user and req.auth.
 * 401 codes tell the client what to do: TOKEN_EXPIRED -> call /auth/refresh and retry; anything else -> log in.
 */
export const protect = asyncHandler(async (req, _res, next) => {
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
  if (!(await isSessionActive(payload.sid))) throw new ApiError(401, 'You have been logged out. Please log in again.', { code: 'SESSION_ENDED' });

  const user = await loadSessionUser(payload.sub);
  if (!user) throw new ApiError(401, 'Account not found');
  if (user.status === 'blocked') throw new ApiError(403, 'Your account has been suspended. Please contact support.');
  // Tokens issued before the last password change are no longer valid.
  if (user.passwordChangedAt && payload.iat < Math.floor(new Date(user.passwordChangedAt).getTime() / 1000)) {
    throw new ApiError(401, 'Your password was changed. Please log in again.', { code: 'SESSION_ENDED' });
  }

  req.user = user;
  req.auth = payload;
  next();
});

/** Attaches req.user when a valid token is present, but never rejects the request. */
export const optionalAuth = (req, res, next) => {
  if (!req.headers.authorization) return next();
  return protect(req, res, (err) => {
    if (err) req.user = undefined;
    next();
  });
};

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
