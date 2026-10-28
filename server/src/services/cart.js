import { Cart } from '../models/Cart.js';
import { Product } from '../models/Product.js';
import { cache } from './cache.js';
import { getSettings, shippingFor } from './pricing.js';
import { ApiError, round2 } from '../utils/http.js';

export const MAX_PER_ITEM = 10;
const TTL = 60 * 60 * 24 * 30;
const cacheKey = (userId) => `cart:${userId}`;

/** Reads the raw cart ([{ productId, quantity }]) from Redis, falling back to MongoDB on a miss. */
async function readRaw(userId) {
  const cached = await cache.getJSON(cacheKey(userId));
  if (Array.isArray(cached)) return cached;
  const doc = await Cart.findOne({ user: userId }).lean();
  const items = (doc?.items || []).map((i) => ({ productId: String(i.product), quantity: i.quantity }));
  await cache.setJSON(cacheKey(userId), items, TTL);
  return items;
}

/** Write-through: MongoDB keeps the durable copy, Redis serves reads. */
async function writeRaw(userId, items) {
  await Cart.updateOne(
    { user: userId },
    { $set: { items: items.map((i) => ({ product: i.productId, quantity: i.quantity })) } },
    { upsert: true },
  );
  await cache.setJSON(cacheKey(userId), items, TTL);
  return items;
}

async function sellableProduct(productId) {
  const product = await Product.findById(productId).populate('vendor', 'status').lean();
  if (!product || !product.isActive || product.vendor?.status !== 'approved') {
    throw new ApiError(404, 'This product is no longer available');
  }
  if (product.stock <= 0) throw new ApiError(400, 'This product is out of stock');
  return product;
}

/** Returns the cart with live product data, stock checks and price summary. */
export async function getCart(userId) {
  const raw = await readRaw(userId);
  const products = await Product.find({ _id: { $in: raw.map((r) => r.productId) } })
    .populate('vendor', 'storeName slug status')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = [];
  let changed = false;
  for (const line of raw) {
    const p = byId.get(line.productId);
    if (!p || !p.isActive || p.vendor?.status !== 'approved') {
      changed = true;
      continue;
    }
    const maxQuantity = Math.min(p.stock, MAX_PER_ITEM);
    const quantity = maxQuantity > 0 ? Math.min(line.quantity, maxQuantity) : line.quantity;
    if (quantity !== line.quantity) changed = true;
    items.push({
      productId: line.productId,
      quantity,
      inStock: p.stock > 0,
      maxQuantity,
      lineTotal: round2(p.price * quantity),
      product: {
        _id: p._id,
        title: p.title,
        slug: p.slug,
        brand: p.brand,
        category: p.category,
        thumbnail: p.thumbnail,
        price: p.price,
        mrp: p.mrp,
        stock: p.stock,
      },
      vendor: { _id: p.vendor._id, storeName: p.vendor.storeName, slug: p.vendor.slug },
    });
  }
  if (changed) await writeRaw(userId, items.map(({ productId, quantity }) => ({ productId, quantity })));

  const settings = await getSettings();
  const buyable = items.filter((i) => i.inStock);
  const subtotal = round2(buyable.reduce((sum, i) => sum + i.lineTotal, 0));
  const mrpTotal = round2(buyable.reduce((sum, i) => sum + (i.product.mrp || i.product.price) * i.quantity, 0));
  const shipping = shippingFor(subtotal, settings);
  return {
    items,
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

export async function addItem(userId, productId, quantity = 1) {
  const product = await sellableProduct(productId);
  const items = await readRaw(userId);
  const existing = items.find((i) => i.productId === String(productId));
  const limit = Math.min(product.stock, MAX_PER_ITEM);
  if (existing) existing.quantity = Math.min(existing.quantity + quantity, limit);
  else items.unshift({ productId: String(productId), quantity: Math.min(quantity, limit) });
  await writeRaw(userId, items);
  return getCart(userId);
}

export async function setQuantity(userId, productId, quantity) {
  let items = await readRaw(userId);
  if (quantity <= 0) {
    items = items.filter((i) => i.productId !== String(productId));
  } else {
    const product = await sellableProduct(productId);
    const line = items.find((i) => i.productId === String(productId));
    if (!line) throw new ApiError(404, 'Item is not in your cart');
    line.quantity = Math.min(quantity, product.stock, MAX_PER_ITEM);
  }
  await writeRaw(userId, items);
  return getCart(userId);
}

export async function clearCart(userId) {
  await writeRaw(userId, []);
}

/** Empties the durable cart inside a caller's transaction; pair with invalidateCartCache() after commit. */
export async function clearCartItems(userId, session) {
  await Cart.updateOne({ user: userId }, { $set: { items: [] } }, { session });
}

export const invalidateCartCache = (userId) => cache.del(cacheKey(userId));

/** Merges a guest cart (kept in the browser) into the user's cart after login. */
export async function mergeItems(userId, guestItems = []) {
  const items = await readRaw(userId);
  const ids = guestItems.map((g) => g.productId);
  const products = await Product.find({ _id: { $in: ids }, isActive: true, stock: { $gt: 0 } }).select('stock').lean();
  const stockById = new Map(products.map((p) => [String(p._id), p.stock]));
  for (const guest of guestItems) {
    const stock = stockById.get(String(guest.productId));
    if (!stock) continue;
    const limit = Math.min(stock, MAX_PER_ITEM);
    const existing = items.find((i) => i.productId === String(guest.productId));
    if (existing) existing.quantity = Math.min(Math.max(existing.quantity, guest.quantity), limit);
    else items.push({ productId: String(guest.productId), quantity: Math.min(guest.quantity, limit) });
  }
  await writeRaw(userId, items);
  return getCart(userId);
}
