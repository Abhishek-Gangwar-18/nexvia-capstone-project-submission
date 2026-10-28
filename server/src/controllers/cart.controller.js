import { z } from 'zod';
import { addItem, getCart, mergeItems, setQuantity, clearCart, MAX_PER_ITEM } from '../services/cart.js';
import { evaluateCoupon, getSettings, shippingFor } from '../services/pricing.js';
import { ApiError, round2 } from '../utils/http.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid product id');

export const addItemSchema = z.object({
  productId: objectId,
  quantity: z.coerce.number().int().min(1).max(MAX_PER_ITEM).default(1),
});

export const quantitySchema = z.object({
  quantity: z.coerce.number().int().min(0).max(MAX_PER_ITEM),
});

export const mergeSchema = z.object({
  items: z.array(z.object({ productId: objectId, quantity: z.coerce.number().int().min(1).max(MAX_PER_ITEM) })).max(50),
});

export const couponSchema = z.object({ code: z.string().trim().min(1, 'Enter a coupon code').max(30) });

export async function show(req, res) {
  res.json(await getCart(req.user._id));
}

export async function add(req, res) {
  res.status(201).json(await addItem(req.user._id, req.body.productId, req.body.quantity));
}

export async function update(req, res) {
  res.json(await setQuantity(req.user._id, req.params.productId, req.body.quantity));
}

export async function remove(req, res) {
  res.json(await setQuantity(req.user._id, req.params.productId, 0));
}

export async function clear(req, res) {
  await clearCart(req.user._id);
  res.json(await getCart(req.user._id));
}

export async function merge(req, res) {
  res.json(await mergeItems(req.user._id, req.body.items));
}

/** Previews a coupon against the current cart (the discount is re-validated at checkout). */
export async function applyCoupon(req, res) {
  const cart = await getCart(req.user._id);
  const lines = cart.items.filter((i) => i.inStock);
  if (!lines.length) throw new ApiError(400, 'Your cart is empty');
  const result = await evaluateCoupon(
    req.body.code,
    lines.map((l) => ({ vendorId: String(l.vendor._id), lineTotal: l.lineTotal })),
    req.user._id,
  );
  const settings = await getSettings();
  const afterDiscount = round2(cart.summary.subtotal - result.discount);
  const shipping = shippingFor(afterDiscount, settings);
  res.json({
    coupon: result.summary,
    summary: { ...cart.summary, discount: result.discount, shipping, total: round2(afterDiscount + shipping) },
  });
}
