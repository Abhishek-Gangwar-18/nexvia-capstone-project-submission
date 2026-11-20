import { Cart, MAX_LINES, MAX_PER_ITEM } from '../models/Cart.ts';
import { isListed, Product } from '../models/Product.ts';
import { cache } from './cache.ts';
import { getSettings, shippingFor } from './pricing.ts';
import { ApiError, round2 } from '../utils/http.ts';

export { MAX_PER_ITEM };
// Short expiry bounds the one cache-aside gap (a read refilling an old cart right after a write deleted the key).
const TTL = 60 * 10;
const cacheKey = (userId) => `cart:${userId}`;
// Update validators run the line schema (quantity 1-10, integer) on $set / $push.
const WRITE = { runValidators: true };

/**
 * Raw cart lines from Redis, falling back to MongoDB on a miss (cache-aside). Writes never touch the
 * cached value: they change MongoDB atomically and then delete the key, so a slow write can't leave
 * an older cart in Redis than in MongoDB.
 */
async function readRaw(userId) {
  const cached = await cache.getJSON(cacheKey(userId));
  if (Array.isArray(cached)) return cached;
  const doc = await Cart.findOne({ user: userId }).lean();
  const items = (doc?.items || []).map((i) => ({ productId: String(i.product), quantity: i.quantity, priceAtAdd: i.priceAtAdd, addedAt: i.addedAt }));
  await cache.setJSON(cacheKey(userId), items, TTL);
  return items;
}


/** Product ids in a customer's cart (for live updates: is a changed product in this cart?). */
export const cartProductIds = async (userId) => (await readRaw(userId)).map((l) => String(l.productId));

export const invalidateCartCache = (userId) => cache.del(cacheKey(userId));

async function sellableProduct(productId) {
  const product = await Product.findById(productId).populate<{ vendor: { _id: unknown; status: string } }>('vendor', 'status').lean();
  if (!product || !isListed(product) || product.vendor?.status !== 'approved') {
    throw new ApiError(404, 'This product is no longer available');
  }
  if (product.stock <= 0) throw new ApiError(400, 'This product is out of stock');
  return product;
}

/**
 * Returns the cart with live product data and the price summary. Reading never rewrites the stored
 * quantities: `quantity` is what can be bought right now (capped by live stock), `requestedQuantity`
 * is what the customer asked for, so a temporary stock dip doesn't shrink the cart for good.
 */
export async function getCart(userId) {
  const raw = await readRaw(userId);
  const products = await Product.find({ _id: { $in: raw.map((r) => r.productId) } })
    .populate<{ vendor: { _id: unknown; storeName: string; status: string } }>('vendor', 'storeName status')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = [];
  const gone = [];
  /** Lines dropped on this read (deleted, hidden, store suspended): reported once so the UI can say so. */
  const removed = [];
  for (const line of raw) {
    const p = byId.get(line.productId);
    if (!p || !isListed(p) || p.vendor?.status !== 'approved') {
      gone.push(line.productId);
      removed.push({ productId: line.productId, title: p?.title || 'A product' });
      continue;
    }
    const maxQuantity = Math.min(p.stock, MAX_PER_ITEM);
    const quantity = maxQuantity > 0 ? Math.min(line.quantity, maxQuantity) : line.quantity;
    const priceChanged = line.priceAtAdd != null && line.priceAtAdd !== p.price ? { from: line.priceAtAdd, to: p.price } : null;
    items.push({
      productId: line.productId,
      quantity,
      requestedQuantity: line.quantity,
      limited: quantity < line.quantity,
      inStock: p.stock > 0,
      maxQuantity,
      priceChanged,
      addedAt: line.addedAt,
      lineTotal: round2(p.price * quantity),
      product: {
        _id: p._id,
        title: p.title,
        brand: p.brand,
        category: p.category,
        thumbnail: p.thumbnail,
        price: p.price,
        mrp: p.mrp,
        stock: p.stock,
      },
      vendor: { _id: p.vendor._id, storeName: p.vendor.storeName },
    });
  }
  // Products that were deleted, hidden or whose store is no longer approved leave the cart for good.
  if (gone.length) {
    await Cart.updateOne({ user: userId }, { $pull: { items: { product: { $in: gone } } } });
    await invalidateCartCache(userId);
  }

  const settings = await getSettings();
  const buyable = items.filter((i) => i.inStock);
  const subtotal = round2(buyable.reduce((sum, i) => sum + i.lineTotal, 0));
  const mrpTotal = round2(buyable.reduce((sum, i) => sum + (i.product.mrp || i.product.price) * i.quantity, 0));
  const shipping = shippingFor(subtotal, settings);
  return {
    items,
    removed,
    summary: {
      itemCount: buyable.reduce((sum, i) => sum + i.quantity, 0),
      subtotal,
      mrpTotal,
      savings: round2(mrpTotal - subtotal),
      shipping,
      total: round2(subtotal + shipping),
      freeShippingThreshold: settings.freeShippingThreshold,
      shippingFee: settings.shippingFee,
    },
  };
}

/**
 * Adds a line or sets its quantity (POST /cart/items is the single item write). Each step is one atomic
 * update on one line, so concurrent writes from two tabs never overwrite each other.
 */
export async function setItem(userId, productId, quantity) {
  const product = await sellableProduct(productId);
  const qty = Math.min(quantity, product.stock, MAX_PER_ITEM);

  const updated = await Cart.updateOne({ user: userId, 'items.product': productId }, { $set: { 'items.$.quantity': qty } }, WRITE);
  if (!updated.matchedCount) {
    try {
      // Matches only while the product is absent and the cart has room; upserts the first cart.
      await Cart.updateOne(
        { user: userId, 'items.product': { $ne: productId }, [`items.${MAX_LINES - 1}`]: { $exists: false } },
        { $push: { items: { $each: [{ product: productId, quantity: qty, priceAtAdd: product.price }], $position: 0 } } },
        { ...WRITE, upsert: true },
      );
    } catch (err) {
      if (err.code !== 11000) throw err;
      // The cart exists but didn't match: another request just added this product, or the cart is full.
      const raced = await Cart.updateOne({ user: userId, 'items.product': productId }, { $set: { 'items.$.quantity': qty } }, WRITE);
      if (!raced.matchedCount) throw new ApiError(400, `Your cart can hold up to ${MAX_LINES} products`);
    }
  }
  await invalidateCartCache(userId);
  return getCart(userId);
}

export async function removeItem(userId, productId) {
  await Cart.updateOne({ user: userId }, { $pull: { items: { product: productId } } });
  await invalidateCartCache(userId);
  return getCart(userId);
}

export async function clearCart(userId) {
  await Cart.updateOne({ user: userId }, { $set: { items: [] } });
  await invalidateCartCache(userId);
}

/** Empties the durable cart inside a caller's transaction; pair with invalidateCartCache() after commit. */
export async function clearCartItems(userId, session) {
  await Cart.updateOne({ user: userId }, { $set: { items: [] } }, { session });
}
