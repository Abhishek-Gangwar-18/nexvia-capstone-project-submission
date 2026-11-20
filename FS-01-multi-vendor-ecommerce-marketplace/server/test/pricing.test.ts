/**
 * Pricing: shipping, coupon validation and discount maths, splitting a discount across packages,
 * and the platform commission / vendor earning on each package.
 * No database is touched: model calls are faked per test.
 * Run: pnpm test
 */
import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const src = (path) => new URL(`../src/${path}`, import.meta.url).href;

let redemptions = [];
mock.module(src('services/coupons.ts'), {
  exports: { liveRedemptions: async () => redemptions },
});

const { Coupon } = await import(src('models/Coupon.ts'));
const { Vendor } = await import(src('models/Vendor.ts'));
const { shippingFor, evaluateCoupon, distributeDiscount, applyCommission } = await import(src('services/pricing.ts'));
const { ApiError } = await import(src('utils/http.ts'));

const VENDOR_A = new mongoose.Types.ObjectId();
const VENDOR_B = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;

let coupon;
const makeCoupon = (fields = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  code: 'SAVE10',
  description: '10% off',
  type: 'percent',
  value: 10,
  minOrder: 0,
  maxDiscount: null,
  isActive: true,
  usageLimit: null,
  usedCount: 0,
  perUserLimit: 1,
  vendor: null,
  ...fields,
});

beforeEach(() => {
  redemptions = [];
  coupon = makeCoupon();
  Coupon.findOne = async ({ code }) => (coupon && code === coupon.code ? coupon : null);
  Vendor.findById = () => ({ select: () => ({ lean: async () => ({ storeName: 'Casa Living' }) }) });
});

const lines = [
  { vendorId: VENDOR_A, lineTotal: 600 },
  { vendorId: VENDOR_B, lineTotal: 400 },
];

const rejects = (promise, status, message) =>
  assert.rejects(promise, (err: any) => err instanceof ApiError && err.status === status && message.test(err.message));

describe('shipping', () => {
  const settings = { freeShippingThreshold: 499, shippingFee: 40 };

  test('below the threshold pays the fee; at or above it ships free', () => {
    assert.equal(shippingFor(100, settings), 40);
    assert.equal(shippingFor(498.99, settings), 40);
    assert.equal(shippingFor(499, settings), 0);
    assert.equal(shippingFor(5000, settings), 0);
  });

  test('an empty cart is not charged shipping', () => {
    assert.equal(shippingFor(0, settings), 0);
    assert.equal(shippingFor(-5, settings), 0);
  });
});

describe('coupon validation', () => {
  test('codes are matched case-insensitively and trimmed', async () => {
    const result = await evaluateCoupon('  save10 ', lines, USER);
    assert.equal(result.coupon, coupon);
    assert.equal(result.discount, 100);
  });

  test('an unknown, empty or inactive code is not valid', async () => {
    await rejects(evaluateCoupon('NOPE', lines, USER), 404, /not valid/);
    await rejects(evaluateCoupon(undefined, lines, USER), 404, /not valid/);
    coupon.isActive = false;
    await rejects(evaluateCoupon('SAVE10', lines, USER), 404, /not valid/);
  });

  test('a coupon is refused before it starts and after it expires', async () => {
    coupon.startsAt = new Date(Date.now() + DAY);
    await rejects(evaluateCoupon('SAVE10', lines, USER), 400, /not active yet/);
    coupon.startsAt = new Date(Date.now() - 2 * DAY);
    coupon.expiresAt = new Date(Date.now() - DAY);
    await rejects(evaluateCoupon('SAVE10', lines, USER), 400, /expired/);
  });

  test('the overall usage limit and the per-customer limit are enforced', async () => {
    coupon.usageLimit = 5;
    coupon.usedCount = 5;
    await rejects(evaluateCoupon('SAVE10', lines, USER), 400, /usage limit/);
    coupon.usedCount = 4;
    redemptions = [{ slot: 1 }];
    await rejects(evaluateCoupon('SAVE10', lines, USER), 400, /already used/);
    coupon.perUserLimit = 2;
    assert.equal((await evaluateCoupon('SAVE10', lines, USER)).discount, 100);
  });

  test('the minimum order says how much more is needed', async () => {
    coupon.minOrder = 1500;
    await rejects(evaluateCoupon('SAVE10', lines, USER), 400, /Add ₹500 more/);
  });

  test('a store coupon only counts that store\'s items and names the store otherwise', async () => {
    coupon.vendor = VENDOR_B;
    coupon.minOrder = 500;
    // 1,000 in the cart, but only 400 from this store
    await rejects(evaluateCoupon('SAVE10', lines, USER), 400, /Add ₹100 more/);
    coupon.minOrder = 0;
    const result = await evaluateCoupon('SAVE10', lines, USER);
    assert.equal(result.discount, 40);
    assert.equal(result.vendorId, String(VENDOR_B));
    await rejects(evaluateCoupon('SAVE10', [lines[0]], USER), 400, /only works on products from Casa Living/);
  });
});

describe('coupon discount', () => {
  test('a percent discount is capped by maxDiscount', async () => {
    coupon.value = 50;
    coupon.maxDiscount = 200;
    assert.equal((await evaluateCoupon('SAVE10', lines, USER)).discount, 200);
  });

  test('a flat discount never exceeds what it applies to', async () => {
    Object.assign(coupon, { type: 'flat', value: 5000 });
    assert.equal((await evaluateCoupon('SAVE10', lines, USER)).discount, 1000);
    coupon.vendor = VENDOR_B;
    assert.equal((await evaluateCoupon('SAVE10', lines, USER)).discount, 400);
  });

  test('discounts are whole rupees', async () => {
    coupon.value = 15;
    const result = await evaluateCoupon('SAVE10', [{ vendorId: VENDOR_A, lineTotal: 333 }], USER);
    assert.equal(result.discount, 50); // 49.95 rounded
    assert.deepEqual(Object.keys(result.summary).sort(), ['code', 'description', 'discount', 'type', 'value']);
  });
});

describe('discount split across packages', () => {
  const packages = () => [
    { vendor: VENDOR_A, subtotal: 333.33 },
    { vendor: VENDOR_B, subtotal: 666.67 },
    { vendor: VENDOR_A, subtotal: 100 },
  ];
  const sum = (pkgs) => Math.round(pkgs.reduce((s, p) => s + (p.discount || 0), 0) * 100) / 100;

  test('a platform discount is shared by subtotal and adds up exactly', () => {
    const result = distributeDiscount(packages(), 101, null);
    assert.equal(sum(result), 101);
    assert.ok(result[1].discount > result[0].discount && result[0].discount > result[2].discount);
  });

  test('awkward amounts still add up to the discount', () => {
    for (const discount of [1, 7, 33.33, 99.99, 250]) {
      assert.equal(sum(distributeDiscount(packages(), discount, null)), discount);
    }
  });

  test('a store discount only touches that store\'s packages', () => {
    const result = distributeDiscount(packages(), 50, String(VENDOR_A));
    assert.equal(result[1].discount, undefined);
    assert.equal(sum(result), 50);
  });

  test('a package is never discounted below zero', () => {
    const result = distributeDiscount([{ vendor: VENDOR_A, subtotal: 10 }], 25, null);
    assert.equal(result[0].discount, 10);
  });
});

describe('commission', () => {
  test('platform commission and vendor earning add up to the package total', () => {
    const pkg = applyCommission({ subtotal: 1000, discount: 100 }, 10);
    assert.equal(pkg.total, 900);
    assert.equal(pkg.commission, 90);
    assert.equal(pkg.vendorEarning, 810);
    assert.equal(pkg.commissionRate, 10);
  });

  test('paise are rounded and nothing is lost', () => {
    const pkg = applyCommission({ subtotal: 333.33 }, 12.5);
    assert.equal(pkg.total, 333.33);
    assert.equal(pkg.commission, 41.67);
    assert.equal(Math.round((pkg.commission + pkg.vendorEarning) * 100) / 100, pkg.total);
  });

  test('a zero rate pays the vendor everything', () => {
    const pkg = applyCommission({ subtotal: 500, discount: 0 }, 0);
    assert.equal(pkg.commission, 0);
    assert.equal(pkg.vendorEarning, 500);
  });
});
