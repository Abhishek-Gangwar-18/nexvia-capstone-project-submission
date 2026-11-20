import { Router } from 'express';
import * as cart from '../controllers/cart.controller.ts';
import * as orders from '../controllers/order.controller.ts';
import * as returns from '../controllers/return.controller.ts';
import { authorize, protect } from '../middleware/auth.ts';
import { validate } from '../middleware/validate.ts';
import { asyncHandler } from '../utils/http.ts';

const router = Router();

// Cart (Redis-backed, customers only). POST /cart/items sets a line's quantity; DELETE removes it.
const customer = [protect, authorize('customer')];
router.get('/cart', customer, asyncHandler(cart.show));
router.get('/cart/events', customer, cart.events);
router.post('/cart/items', customer, validate(cart.addItemSchema), asyncHandler(cart.add));
router.delete('/cart/items/:productId', customer, asyncHandler(cart.remove));
router.delete('/cart', customer, asyncHandler(cart.clear));
router.post('/cart/coupon', customer, validate(cart.couponSchema), asyncHandler(cart.applyCoupon));

// Orders & payments
router.post('/orders/checkout', customer, validate(orders.checkoutSchema), asyncHandler(orders.checkout));
router.get('/orders', customer, asyncHandler(orders.listMyOrders));
router.get('/orders/:id', customer, asyncHandler(orders.getOrder));
router.get('/orders/:id/invoice', customer, asyncHandler(orders.invoice));
router.get('/orders/:id/payment', customer, asyncHandler(orders.paymentConfig));
router.post('/orders/:id/verify', customer, validate(orders.verifySchema), asyncHandler(orders.verifyPayment));
router.post('/orders/:id/cancel', customer, validate(orders.cancelSchema), asyncHandler(orders.cancelOrder));

// Returns (delivered packages, within the return window)
router.get('/orders/:id/returns', customer, asyncHandler(returns.orderReturns));
router.post('/orders/:id/returns', customer, validate(returns.returnRequestSchema), asyncHandler(returns.createReturn));
router.get('/returns', customer, asyncHandler(returns.myReturns));
router.post('/returns/:returnId/cancel', customer, asyncHandler(returns.withdrawReturn));

export default router;
