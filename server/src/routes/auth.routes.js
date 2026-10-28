import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as auth from '../controllers/auth.controller.js';
import { protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again in a few minutes.' },
});

// Stricter limit: a wrong current password is a guessing attempt.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many password change attempts. Please try again later.' },
});

router.post('/register', authLimiter, validate(auth.registerSchema), asyncHandler(auth.register));
router.post('/login', authLimiter, validate(auth.loginSchema), asyncHandler(auth.login));
router.post('/logout', protect, asyncHandler(auth.logout));

// Hourly cap on top of the per-user cooldown/daily limit in the controller.
const verifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many verification requests. Please try again later.' },
});

router.post('/verify-email', verifyLimiter, validate(auth.verifyEmailSchema), asyncHandler(auth.verifyEmail));
router.post('/verify-email/resend', protect, verifyLimiter, asyncHandler(auth.resendVerification));

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
