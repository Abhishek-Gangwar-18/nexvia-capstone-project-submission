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

router.post('/register', authLimiter, validate(auth.registerSchema), asyncHandler(auth.register));
router.post('/login', authLimiter, validate(auth.loginSchema), asyncHandler(auth.login));
router.post('/logout', protect, asyncHandler(auth.logout));

router.get('/me', protect, asyncHandler(auth.me));
router.patch('/me', protect, validate(auth.profileSchema), asyncHandler(auth.updateMe));
router.put('/me/password', protect, validate(auth.passwordSchema), asyncHandler(auth.changePassword));

router.post('/me/addresses', protect, validate(auth.addressSchema), asyncHandler(auth.addAddress));
router.put('/me/addresses/:addressId', protect, validate(auth.addressSchema), asyncHandler(auth.updateAddress));
router.delete('/me/addresses/:addressId', protect, asyncHandler(auth.deleteAddress));

router.get('/me/wishlist', protect, asyncHandler(auth.getWishlist));
router.post('/me/wishlist/:productId', protect, asyncHandler(auth.toggleWishlist));

export default router;
