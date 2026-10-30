import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as catalog from '../controllers/catalog.controller.js';
import * as reviews from '../controllers/review.controller.js';
import { optionalAuth, protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { imageUpload, verifyImages } from '../middleware/upload.js';
import { asyncHandler } from '../utils/http.js';
import { CacheStore } from '../services/rateLimitStore.js';

const router = Router();

// Per account, and checked before multer reads the files, so a refused request never buffers its 40 MB.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  store: new CacheStore('upload'),
  keyGenerator: (req) => String(req.user._id),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many uploads. Please try again in a few minutes.' },
});

router.get('/home', asyncHandler(catalog.home));
router.get('/categories', asyncHandler(catalog.listCategories));

router.get('/products', asyncHandler(catalog.listProducts));
router.get('/products/suggest', asyncHandler(catalog.suggestProducts));
router.get('/products/:productId', optionalAuth, asyncHandler(catalog.getProduct));
// Ratings (stars, one per customer) and reviews (comments, up to 20) are separate; both need a delivered order.
router.put('/products/:productId/rating', protect, validate(reviews.ratingSchema), asyncHandler(reviews.rateProduct));
router.delete('/products/:productId/rating', protect, asyncHandler(reviews.unrateProduct));
router.get('/products/:productId/reviews', optionalAuth, asyncHandler(reviews.listReviews));
router.post('/products/:productId/reviews', protect, validate(reviews.reviewSchema), asyncHandler(reviews.createReview));
router.patch('/products/:productId/reviews/:reviewId', protect, validate(reviews.reviewUpdateSchema), asyncHandler(reviews.updateReview));
router.delete('/products/:productId/reviews/:reviewId', protect, asyncHandler(reviews.deleteReview));
router.post('/products/:productId/reviews/:reviewId/helpful', protect, asyncHandler(reviews.voteHelpful));
router.delete('/products/:productId/reviews/:reviewId/helpful', protect, asyncHandler(reviews.unvoteHelpful));

router.get('/coupons', asyncHandler(catalog.publicCoupons));

router.get('/stores', asyncHandler(catalog.listStores));
router.get('/stores/:storeId', asyncHandler(catalog.getStore));

router.post('/uploads', protect, uploadLimiter, imageUpload.array('images', 8), verifyImages, asyncHandler(catalog.uploadImages));

export default router;
