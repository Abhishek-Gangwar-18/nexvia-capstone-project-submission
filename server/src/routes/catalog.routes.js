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
router.get('/products/:idOrSlug', optionalAuth, asyncHandler(catalog.getProduct));
router.get('/products/:id/reviews', optionalAuth, asyncHandler(catalog.getReviews));
router.post('/products/:id/reviews', protect, validate(catalog.reviewSchema), asyncHandler(catalog.upsertReview));
router.delete('/products/:id/reviews/mine', protect, asyncHandler(catalog.deleteMyReview));

router.get('/coupons', asyncHandler(catalog.publicCoupons));

router.get('/stores', asyncHandler(catalog.listStores));
router.get('/stores/:slug', asyncHandler(catalog.getStore));

router.post('/uploads', protect, imageUpload.array('images', 8), asyncHandler(catalog.uploadImages));

export default router;
