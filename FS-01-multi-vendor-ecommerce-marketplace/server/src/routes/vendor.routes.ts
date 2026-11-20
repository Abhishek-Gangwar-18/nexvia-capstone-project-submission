import { Router } from 'express';
import * as vendor from '../controllers/vendor.controller.ts';
import * as reviews from '../controllers/review.controller.ts';
import * as coupons from '../controllers/coupon.controller.ts';
import * as payouts from '../controllers/payout.controller.ts';
import * as returns from '../controllers/return.controller.ts';
import { authorize, loadVendor, protect } from '../middleware/auth.ts';
import { validate } from '../middleware/validate.ts';
import { asyncHandler } from '../utils/http.ts';

const router = Router();

// Onboarding is open to customers too ("Become a seller"); it upgrades their role to vendor.
router.post('/onboard', protect, authorize('customer', 'vendor'), validate(vendor.onboardSchema), asyncHandler(vendor.onboard));

// Store profile is editable while pending/rejected so sellers can fix their application.
router.get('/store', protect, authorize('vendor'), loadVendor({ approved: false }), asyncHandler(vendor.myStore));
router.patch('/store', protect, authorize('vendor'), loadVendor({ approved: false }), validate(vendor.storeUpdateSchema), asyncHandler(vendor.updateStore));

// Stripe Connect payouts: can be set up while the application is still pending.
const anyStore = [protect, authorize('vendor'), loadVendor({ approved: false })];
router.get('/stripe', anyStore, asyncHandler(payouts.stripeStatus));
router.post('/stripe/onboarding', anyStore, validate(payouts.connectSchema), asyncHandler(payouts.startOnboarding));
router.post('/stripe/replace', anyStore, validate(payouts.replaceSchema), asyncHandler(payouts.replaceAccount));
router.post('/stripe/dashboard', anyStore, asyncHandler(payouts.stripeDashboard));

// Everything below requires an approved store.
router.use(protect, authorize('vendor'), loadVendor({ approved: true }));

router.get('/dashboard', asyncHandler(vendor.dashboard));

router.get('/products', asyncHandler(vendor.listMyProducts));
router.post('/products', validate(vendor.productCreateSchema), asyncHandler(vendor.createProduct));
router.get('/products/:id', asyncHandler(vendor.getMyProduct));
router.patch('/products/:id', validate(vendor.productUpdateSchema), asyncHandler(vendor.updateProduct));
router.delete('/products/:id', asyncHandler(vendor.deleteProduct));

router.get('/orders', asyncHandler(vendor.listOrders));
router.patch('/orders/:orderId/status', validate(vendor.statusSchema), asyncHandler(vendor.updateOrderStatus));

router.get('/payouts', asyncHandler(vendor.payouts));

router.get('/returns', asyncHandler(returns.vendorReturns));
router.patch('/returns/:returnId', validate(returns.returnDecisionSchema), asyncHandler(returns.vendorDecide));
router.post('/returns/:returnId/receive', validate(returns.returnReceiveSchema), asyncHandler(returns.vendorReceive));

router.get('/reviews', asyncHandler(reviews.vendorReviews));
router.put('/reviews/:id/reply', validate(reviews.replySchema), asyncHandler(reviews.replyToReview));
router.delete('/reviews/:id/reply', asyncHandler(reviews.deleteReply));

router.get('/coupons', asyncHandler(coupons.listCoupons));
router.post('/coupons', validate(coupons.couponCreateSchema), asyncHandler(coupons.createCoupon));
router.patch('/coupons/:id', validate(coupons.couponUpdateSchema), asyncHandler(coupons.updateCoupon));
router.delete('/coupons/:id', asyncHandler(coupons.deleteCoupon));

export default router;
