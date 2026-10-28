import { Router } from 'express';
import * as vendor from '../controllers/vendor.controller.js';
import * as coupons from '../controllers/coupon.controller.js';
import { authorize, loadVendor, protect, requireVerifiedEmail } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();

// Onboarding is open to customers too ("Become a seller"); it upgrades their role to vendor.
router.post('/onboard', protect, authorize('customer', 'vendor'), requireVerifiedEmail, validate(vendor.onboardSchema), asyncHandler(vendor.onboard));

// Store profile is editable while pending/rejected so sellers can fix their application.
router.get('/store', protect, authorize('vendor'), loadVendor({ approved: false }), asyncHandler(vendor.myStore));
router.put('/store', protect, authorize('vendor'), loadVendor({ approved: false }), validate(vendor.storeUpdateSchema), asyncHandler(vendor.updateStore));

// Everything below requires an approved store.
router.use(protect, authorize('vendor'), loadVendor({ approved: true }));

router.get('/dashboard', asyncHandler(vendor.dashboard));

router.get('/products', asyncHandler(vendor.listMyProducts));
router.post('/products', validate(vendor.productCreateSchema), asyncHandler(vendor.createProduct));
router.get('/products/:id', asyncHandler(vendor.getMyProduct));
router.put('/products/:id', validate(vendor.productUpdateSchema), asyncHandler(vendor.updateProduct));
router.delete('/products/:id', asyncHandler(vendor.deleteProduct));

router.get('/orders', asyncHandler(vendor.listOrders));
router.patch('/orders/:orderId/status', validate(vendor.statusSchema), asyncHandler(vendor.updateOrderStatus));

router.get('/payouts', asyncHandler(vendor.payouts));

router.get('/coupons', asyncHandler(coupons.listCoupons));
router.post('/coupons', validate(coupons.couponCreateSchema), asyncHandler(coupons.createCoupon));
router.put('/coupons/:id', validate(coupons.couponUpdateSchema), asyncHandler(coupons.updateCoupon));
router.delete('/coupons/:id', asyncHandler(coupons.deleteCoupon));

export default router;
