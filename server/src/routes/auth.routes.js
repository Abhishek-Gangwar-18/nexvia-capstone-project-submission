import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as auth from '../controllers/auth.controller.js';
import { optionalAuth, protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';
import { CacheStore } from '../services/rateLimitStore.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  store: new CacheStore('auth'),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again in a few minutes.' },
});

// Every open tab refreshes about every 15 minutes; this only stops scripted hammering.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  store: new CacheStore('refresh'),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again in a few minutes.' },
});

// Stricter limit: a wrong current password is a guessing attempt.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  store: new CacheStore('password'),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many password change attempts. Please try again later.' },
});

router.post('/register', authLimiter, validate(auth.registerSchema), asyncHandler(auth.register));
router.post('/login', authLimiter, validate(auth.loginSchema), asyncHandler(auth.login));
// Access token: short-lived JWT (Bearer). Refresh token: httpOnly cookie on /auth, rotated on every use.
router.post('/refresh', refreshLimiter, asyncHandler(auth.refresh));
router.post('/logout', optionalAuth, asyncHandler(auth.logout));
router.post('/logout-all', protect, asyncHandler(auth.logoutAll));
router.get('/sessions', protect, asyncHandler(auth.sessions));
router.delete('/sessions/:id', protect, asyncHandler(auth.revokeDevice));

router.get('/status', protect, auth.status);
router.get('/me', protect, asyncHandler(auth.me));
router.patch('/me', protect, validate(auth.profileSchema), asyncHandler(auth.updateMe));
router.patch('/me/password', protect, passwordLimiter, validate(auth.passwordSchema), asyncHandler(auth.changePassword));

router.get('/me/addresses', protect, asyncHandler(auth.listAddresses));
router.post('/me/addresses', protect, validate(auth.addressSchema), asyncHandler(auth.addAddress));
router.patch('/me/addresses/:addressId', protect, validate(auth.addressUpdateSchema), asyncHandler(auth.updateAddress));
router.delete('/me/addresses/:addressId', protect, asyncHandler(auth.deleteAddress));

router.get('/me/wishlist', protect, asyncHandler(auth.getWishlist));
router.put('/me/wishlist/:productId', protect, asyncHandler(auth.addToWishlist));
router.delete('/me/wishlist/:productId', protect, asyncHandler(auth.removeFromWishlist));

export default router;
