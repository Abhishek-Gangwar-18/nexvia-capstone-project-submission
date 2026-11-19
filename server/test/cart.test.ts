/**
 * Cart: quantities capped by stock and the per-item limit, products that left the shop, price changes,
 * totals and shipping, and what can and can't be added.
 * No database or Redis is touched: the models are faked and the cache runs in memory.
 * Run: pnpm test
 */
import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const src = (path) => new URL(`../src/${path}`, import.meta.url).href;

mock.module(src('services/pricing.ts'), {
  exports: {
    getSettings: async () => ({ freeShippingThreshold: 499, shippingFee: 40 }),
    shippingFor: (amount, s) => (amount <= 0 || amount >= s.freeShippingThreshold ? 0 : s.shippingFee),
  },
});

const { Cart } = await import(src('models/Cart.ts'));
const { Product } = await import(src('models/Product.ts'));
const { getCart, setItem, MAX_PER_ITEM } = await import(src('services/cart.ts'));
const { invalidateCartCache } = await import(src('services/cart.ts'));
const { ApiError } = await import(src('utils/http.ts'));

const id = () => new mongoose.Types.ObjectId();
const approvedStore = { _id: id(), storeName: 'Urban Threads', status: 'approved' };

let products;
let stored; // cart lines as MongoDB would hold them
let writes;
const USER = id();

const product = (fields = {}) => {
  const p = { _id: id(), title: 'Tee', price: 100, mrp: 150, stock: 20, isActive: true, deletedAt: null, moderation: { status: 'approved' }, vendor: approvedStore, ...fields };
  products.set(String(p._id), p);
  return p;
};
const line = (p, quantity, priceAtAdd = p.price) => ({ product: p._id, quantity, priceAtAdd, addedAt: new Date() });

beforeEach(async () => {
  products = new Map();
  stored = [];
  writes = [];
  await invalidateCartCache(USER);
  Cart.findOne = () => ({ lean: async () => ({ items: stored }) });
  Cart.updateOne = async (filter, update) => {
    writes.push({ filter, update });
    return { matchedCount: 0 };
  };
  Product.find = ({ _id }) => ({ populate: () => ({ lean: async () => _id.$in.map((pid) => products.get(String(pid))).filter(Boolean) }) });
  Product.findById = (pid) => ({ populate: () => ({ lean: async () => products.get(String(pid)) || null }) });
});

describe('reading the cart', () => {
  test('totals, savings and shipping below the free-shipping threshold', async () => {
    const tee = product();
    const cap = product({ title: 'Cap', price: 49.5, mrp: null });
    stored = [line(tee, 2), line(cap, 3)];
    const { items, summary } = await getCart(USER);
    assert.equal(items.length, 2);
    assert.equal(summary.itemCount, 5);
    assert.equal(summary.subtotal, 348.5);
    assert.equal(summary.mrpTotal, 448.5);
    assert.equal(summary.savings, 100);
    assert.equal(summary.shipping, 40);
    assert.equal(summary.total, 388.5);
  });

  test('free shipping at the threshold', async () => {
    stored = [line(product({ price: 499 }), 1)];
    const { summary } = await getCart(USER);
    assert.equal(summary.shipping, 0);
    assert.equal(summary.total, 499);
  });

  test('quantity is capped by live stock without losing what was asked for', async () => {
    stored = [line(product({ stock: 3 }), 8)];
    const [item] = (await getCart(USER)).items;
    assert.equal(item.quantity, 3);
    assert.equal(item.requestedQuantity, 8);
    assert.equal(item.limited, true);
    assert.equal(item.maxQuantity, 3);
  });

  test('out-of-stock lines stay in the cart but are not charged', async () => {
    stored = [line(product({ stock: 0 }), 2), line(product({ price: 200 }), 1)];
    const { items, summary } = await getCart(USER);
    assert.equal(items.length, 2);
    assert.equal(items[0].inStock, false);
    assert.equal(summary.itemCount, 1);
    assert.equal(summary.subtotal, 200);
  });

  test('a price change since adding is reported', async () => {
    const tee = product({ price: 120 });
    stored = [line(tee, 1, 100)];
    const [item] = (await getCart(USER)).items;
    assert.deepEqual(item.priceChanged, { from: 100, to: 120 });
    assert.equal(item.lineTotal, 120);
  });

  test('deleted, hidden, removed and suspended-store products leave the cart and are reported once', async () => {
    const kept = product();
    const gone = [
      product({ title: 'Deleted', deletedAt: new Date() }),
      product({ title: 'Hidden', isActive: false }),
      product({ title: 'Removed', moderation: { status: 'removed' } }),
      product({ title: 'Suspended', vendor: { ...approvedStore, status: 'suspended' } }),
    ];
    const missing = { _id: id() };
    stored = [line(kept, 1), ...gone.map((p) => line(p, 1)), line(missing, 1)];
    const { items, removed } = await getCart(USER);
    assert.deepEqual(items.map((i) => i.product.title), ['Tee']);
    assert.deepEqual(removed.map((r) => r.title), ['Deleted', 'Hidden', 'Removed', 'Suspended', 'A product']);
    const pull = writes.find((w) => w.update.$pull);
    assert.equal(pull.update.$pull.items.product.$in.length, 5);
  });

  test('an empty cart costs nothing, shipping included', async () => {
    const { items, summary } = await getCart(USER);
    assert.equal(items.length, 0);
    assert.equal(summary.total, 0);
    assert.equal(summary.shipping, 0);
  });
});

describe('adding to the cart', () => {
  const rejects = (promise, status, message) =>
    assert.rejects(promise, (err: any) => err instanceof ApiError && err.status === status && message.test(err.message));

  test('quantity is capped by stock and by the per-item limit', async () => {
    const few = product({ stock: 4 });
    await setItem(USER, few._id, 9);
    assert.equal(writes[0].update.$set['items.$.quantity'], 4);

    const many = product({ stock: 500 });
    await setItem(USER, many._id, 99);
    const set = writes.filter((w) => w.update.$set?.['items.$.quantity'] != null).pop();
    assert.equal(set.update.$set['items.$.quantity'], MAX_PER_ITEM);
  });

  test('a new line records the price at the time it was added', async () => {
    const tee = product({ price: 250 });
    await setItem(USER, tee._id, 2);
    const push = writes.find((w) => w.update.$push);
    const [added] = push.update.$push.items.$each;
    assert.equal(added.quantity, 2);
    assert.equal(added.priceAtAdd, 250);
  });

  test('unavailable products can\'t be added', async () => {
    await rejects(setItem(USER, id(), 1), 404, /no longer available/);
    await rejects(setItem(USER, product({ isActive: false })._id, 1), 404, /no longer available/);
    await rejects(setItem(USER, product({ vendor: { ...approvedStore, status: 'pending' } })._id, 1), 404, /no longer available/);
    await rejects(setItem(USER, product({ stock: 0 })._id, 1), 400, /out of stock/);
  });

  test('a full cart says how many products it can hold', async () => {
    const tee = product();
    Cart.updateOne = async (filter) => {
      if (filter['items.product']?.$ne) throw Object.assign(new Error('dup'), { code: 11000 });
      return { matchedCount: 0 };
    };
    await rejects(setItem(USER, tee._id, 1), 400, /can hold up to 50 products/);
  });
});
