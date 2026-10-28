import { Router } from 'express';
import * as cart from '../controllers/cart.controller.js';
import * as orders from '../controllers/order.controller.js';
import { authorize, protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();

// Cart (Redis-backed, customers only)
const customer = [protect, authorize('customer')];
router.get('/cart', customer, asyncHandler(cart.show));
router.post('/cart/items', customer, validate(cart.addItemSchema), asyncHandler(cart.add));
router.patch('/cart/items/:productId', customer, validate(cart.quantitySchema), asyncHandler(cart.update));
router.delete('/cart/items/:productId', customer, asyncHandler(cart.remove));
router.delete('/cart', customer, asyncHandler(cart.clear));
router.post('/cart/merge', customer, validate(cart.mergeSchema), asyncHandler(cart.merge));
router.post('/cart/coupon', customer, validate(cart.couponSchema), asyncHandler(cart.applyCoupon));

// Orders & payments
router.post('/orders/checkout', customer, validate(orders.checkoutSchema), asyncHandler(orders.checkout));
router.get('/orders', customer, asyncHandler(orders.listMyOrders));
router.get('/orders/:id', protect, asyncHandler(orders.getOrder));
router.get('/orders/:id/invoice', protect, asyncHandler(orders.invoice));
router.get('/orders/:id/payment', customer, asyncHandler(orders.paymentConfig));
router.post('/orders/:id/verify', customer, validate(orders.verifySchema), asyncHandler(orders.verifyPayment));
router.post('/orders/:id/cancel', customer, asyncHandler(orders.cancelOrder));

export default router;
