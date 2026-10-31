import { z } from 'zod';
import { cartProductIds, clearCart, getCart, MAX_PER_ITEM, removeItem, setItem } from '../services/cart.js';
import { productEvents } from '../services/productEvents.js';
import { evaluateCoupon, getSettings, shippingFor } from '../services/pricing.js';
import { ApiError, round2 } from '../utils/http.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid product id');

/** quantity is the line's new total, not an increment. */
export const addItemSchema = z.object({
  productId: objectId,
  quantity: z.coerce.number().int().min(1).max(MAX_PER_ITEM).default(1),
});

export const couponSchema = z.object({ code: z.string().trim().min(1, 'Enter a coupon code').max(30) });

export async function show(req, res) {
  res.json(await getCart(req.user._id));
}

export async function add(req, res) {
  res.json(await setItem(req.user._id, req.body.productId, req.body.quantity));
}

export async function remove(req, res) {
  res.json(await removeItem(req.user._id, req.params.productId));
}

export async function clear(req, res) {
  await clearCart(req.user._id);
  res.json(await getCart(req.user._id));
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

/**
 * GET /cart/events - Server-Sent Events. Sends `cart` whenever a product in this customer's cart changes
 * stock, price or availability (any writer: vendor, other orders, admin), so the open cart refetches at
 * once instead of showing stale quantities. `no-transform` keeps compression from buffering the stream.
 */
export function events(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (chunk) => {
    res.write(chunk);
    res.flush?.();
  };
  send('event: ready\ndata: {}\n\n');

  const onChange = async (productId) => {
    try {
      if ((await cartProductIds(req.user._id)).includes(productId)) send(`event: cart\ndata: ${JSON.stringify({ productId })}\n\n`);
    } catch {
      /* cart unreadable for a moment: the client also refetches on focus */
    }
  };
  productEvents.on('change', onChange);
  // Coupons can apply to anyone's cart, so every connected customer hears about coupon changes.
  const onCoupon = (couponId) => send(`event: coupon\ndata: ${JSON.stringify({ couponId })}\n\n`);
  productEvents.on('coupon', onCoupon);
  const ping = setInterval(() => send(': ping\n\n'), 25_000); // keeps proxies from closing an idle stream
  req.on('close', () => {
    clearInterval(ping);
    productEvents.off('change', onChange);
    productEvents.off('coupon', onCoupon);
  });
}
