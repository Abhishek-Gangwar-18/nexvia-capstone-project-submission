import { Router } from 'express';
import * as admin from '../controllers/admin.controller.js';
import * as coupons from '../controllers/coupon.controller.js';
import { authorize, protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();
router.use(protect, authorize('admin'));

router.get('/analytics', asyncHandler(admin.analytics));

router.get('/vendors', asyncHandler(admin.listVendors));
router.patch('/vendors/:id', validate(admin.vendorUpdateSchema), asyncHandler(admin.updateVendor));

router.get('/users', asyncHandler(admin.listUsers));
router.patch('/users/:id', validate(admin.userUpdateSchema), asyncHandler(admin.updateUser));

router.get('/orders', asyncHandler(admin.listOrders));
router.patch('/orders/:id/packages/:packageId', validate(admin.packageStatusSchema), asyncHandler(admin.updatePackage));

router.get('/products', asyncHandler(admin.listProducts));
router.patch('/products/:id', asyncHandler(admin.moderateProduct));

router.get('/coupons', asyncHandler(coupons.listCoupons));
router.post('/coupons', validate(coupons.couponCreateSchema), asyncHandler(coupons.createCoupon));
router.put('/coupons/:id', validate(coupons.couponUpdateSchema), asyncHandler(coupons.updateCoupon));
router.delete('/coupons/:id', asyncHandler(coupons.deleteCoupon));

router.get('/settings', asyncHandler(admin.getPlatformSettings));
router.put('/settings', validate(admin.settingsSchema), asyncHandler(admin.updatePlatformSettings));

router.get('/system', asyncHandler(admin.system));
router.post('/search/reindex', asyncHandler(admin.reindex));

export default router;
