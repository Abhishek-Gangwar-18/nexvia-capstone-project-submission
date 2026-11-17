import { Router } from 'express';
import * as admin from '../controllers/admin.controller.ts';
import * as categories from '../controllers/category.controller.ts';
import * as coupons from '../controllers/coupon.controller.ts';
import * as payouts from '../controllers/payout.controller.ts';
import * as returns from '../controllers/return.controller.ts';
import * as reviews from '../controllers/review.controller.ts';
import * as orders from '../controllers/order.controller.ts';
import { authorize, protect } from '../middleware/auth.ts';
import { validate } from '../middleware/validate.ts';
import { asyncHandler } from '../utils/http.ts';

const router = Router();
router.use(protect, authorize('admin'));

router.get('/analytics', asyncHandler(admin.analytics));

router.get('/vendors', asyncHandler(admin.listVendors));
router.patch('/vendors/:id', validate(admin.vendorUpdateSchema), asyncHandler(admin.updateVendor));
router.patch('/vendors/:id/payout-hold', validate(payouts.payoutHoldSchema), asyncHandler(payouts.setPayoutHold));

router.get('/users', asyncHandler(admin.listUsers));
router.patch('/users/:id', validate(admin.userUpdateSchema), asyncHandler(admin.updateUser));

router.get('/orders', asyncHandler(admin.listOrders));
router.get('/orders/summary', asyncHandler(admin.orderSummary));
router.get('/orders/export', asyncHandler(admin.exportOrders));
router.get('/orders/:id', asyncHandler(orders.adminGetOrder));
router.get('/orders/:id/invoice', asyncHandler(orders.adminInvoice));
router.patch('/orders/:id/packages/:packageId', validate(admin.packageStatusSchema), asyncHandler(admin.updatePackage));

router.get('/products', asyncHandler(admin.listProducts));
router.patch('/products/:id', validate(admin.moderationSchema), asyncHandler(admin.moderateProduct));

router.get('/reviews', asyncHandler(reviews.adminReviews));
router.patch('/reviews/:id', validate(reviews.moderationSchema), asyncHandler(reviews.moderateReview));

router.get('/categories', asyncHandler(categories.listCategories));
router.post('/categories', validate(categories.categoryCreateSchema), asyncHandler(categories.createCategory));
router.patch('/categories/:id', validate(categories.categoryUpdateSchema), asyncHandler(categories.updateCategory));
router.delete('/categories/:id', asyncHandler(categories.deleteCategory));

router.get('/coupons', asyncHandler(coupons.listCoupons));
router.post('/coupons', validate(coupons.couponCreateSchema), asyncHandler(coupons.createCoupon));
router.patch('/coupons/:id', validate(coupons.couponUpdateSchema), asyncHandler(coupons.updateCoupon));
router.delete('/coupons/:id', asyncHandler(coupons.deleteCoupon));

router.get('/settings', asyncHandler(admin.getPlatformSettings));
router.patch('/settings', validate(admin.settingsSchema), asyncHandler(admin.updatePlatformSettings));

router.get('/system', asyncHandler(admin.system));
router.post('/search/reindex', asyncHandler(admin.reindex));

// Payments: refunds (retry), returns (oversee and act), reconciliation, payout job
router.get('/refunds', asyncHandler(payouts.listRefunds));
router.post('/refunds/:id/retry', asyncHandler(payouts.retryRefundById));
router.get('/returns', asyncHandler(returns.adminReturns));
router.patch('/returns/:returnId', validate(returns.returnDecisionSchema), asyncHandler(returns.adminDecide));
router.post('/returns/:returnId/receive', validate(returns.returnReceiveSchema), asyncHandler(returns.adminReceive));
router.post('/returns/:returnId/refund', asyncHandler(returns.adminRefundReturn));
router.post('/payments/reconcile', asyncHandler(payouts.reconcile));
router.post('/payouts/release', asyncHandler(payouts.releasePayouts));

export default router;
