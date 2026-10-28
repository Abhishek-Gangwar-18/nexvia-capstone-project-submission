import { Router } from 'express';
import * as cart from '../controllers/cart.controller.js';
import * as orders from '../controllers/order.controller.js';
import { authorize, protect, requireVerifiedEmail } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();

// Cart (Redis-backed, customers only). POST /cart/items sets a line's quantity; DELETE removes it.
const customer = [protect, authorize('customer')];
router.get('/cart', customer, asyncHandler(cart.show));
router.post('/cart/items', customer, validate(cart.addItemSchema), asyncHandler(cart.add));
router.delete('/cart/items/:productId', customer, asyncHandler(cart.remove));
router.delete('/cart', customer, asyncHandler(cart.clear));
router.post('/cart/coupon', customer, validate(cart.couponSchema), asyncHandler(cart.applyCoupon));

// Orders & payments
router.post('/orders/checkout', customer, requireVerifiedEmail, validate(orders.checkoutSchema), asyncHandler(orders.checkout));
router.get('/orders', customer, asyncHandler(orders.listMyOrders));
router.get('/orders/:id', customer, asyncHandler(orders.getOrder));
router.get('/orders/:id/invoice', customer, asyncHandler(orders.invoice));
router.get('/orders/:id/payment', customer, asyncHandler(orders.paymentConfig));
router.post('/orders/:id/verify', customer, validate(orders.verifySchema), asyncHandler(orders.verifyPayment));
router.post('/orders/:id/cancel', customer, asyncHandler(orders.cancelOrder));

export default router;
