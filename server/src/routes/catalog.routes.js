import { Router } from 'express';
import * as catalog from '../controllers/catalog.controller.js';
import { optionalAuth, protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { imageUpload } from '../middleware/upload.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();

router.get('/home', asyncHandler(catalog.home));
router.get('/categories', asyncHandler(catalog.listCategories));

router.get('/products', asyncHandler(catalog.listProducts));
router.get('/products/suggest', asyncHandler(catalog.suggestProducts));
router.get('/products/:productId', optionalAuth, asyncHandler(catalog.getProduct));
router.get('/products/:productId/reviews', optionalAuth, asyncHandler(catalog.getReviews));
router.post('/products/:productId/reviews', protect, validate(catalog.reviewSchema), asyncHandler(catalog.createReview));
router.patch('/products/:productId/reviews/:reviewId', protect, validate(catalog.reviewUpdateSchema), asyncHandler(catalog.updateReview));
router.delete('/products/:productId/reviews/:reviewId', protect, asyncHandler(catalog.deleteReview));

router.get('/coupons', asyncHandler(catalog.publicCoupons));

router.get('/stores', asyncHandler(catalog.listStores));
router.get('/stores/:storeId', asyncHandler(catalog.getStore));

router.post('/uploads', protect, imageUpload.array('images', 8), asyncHandler(catalog.uploadImages));

export default router;
