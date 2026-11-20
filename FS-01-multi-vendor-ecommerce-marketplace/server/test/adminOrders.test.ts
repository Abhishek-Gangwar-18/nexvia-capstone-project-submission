/**
 * Admin order management rules: date ranges, exception detection, refund summary and the CSV export.
 * Pure functions only; no database.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dateRange, orderExceptions, ordersCsv, refundSummary, SLA } from '../src/services/adminOrders.ts';

const HOUR = 3600 * 1000;
const now = new Date('2026-10-29T12:00:00Z');
const pkg = (status, extra: Record<string, any> = {}) => ({ _id: `p-${status}`, storeName: 'Store', status, items: [{ title: 'Item', quantity: 1 }], timeline: [], ...extra });
const order = (extra: Record<string, any> = {}) => ({
  orderNumber: 'VD1',
  createdAt: now,
  status: 'placed',
  placedAt: new Date(+now - HOUR),
  customer: 'c1',
  payment: { status: 'paid', provider: 'mock' },
  pricing: { subtotal: 100, discount: 0, shipping: 0, total: 100 },
  packages: [pkg('placed')],
  ...extra,
});
const types = (o) => orderExceptions(o, now).map((e: any) => e.type);

describe('dateRange', () => {
  test('custom days are inclusive IST calendar days', () => {
    const r = dateRange({ from: '2026-10-01', to: '2026-10-01' });
    assert.equal(r.$gte.toISOString(), '2026-09-30T18:30:00.000Z');
    assert.equal(r.$lte.toISOString(), '2026-10-01T18:29:59.999Z');
  });
  test('bad input is a 400', () => {
    for (const q of [{ from: '01-10-2026' }, { from: '2026-10-05', to: '2026-10-01' }, { range: '12' }]) {
      assert.throws(() => dateRange(q), (e: any) => e.status === 400);
    }
  });
  test('no range or "all" means no date condition', () => {
    assert.equal(dateRange({}), null);
    assert.equal(dateRange({ range: 'all' }), null);
  });
});

describe('exceptions', () => {
  test('a healthy fresh order has none', () => assert.deepEqual(types(order()), []));

  test('dispatch is late after the SLA', () => {
    assert.deepEqual(types(order({ placedAt: new Date(+now - (SLA.dispatchHours + 1) * HOUR) })), ['delayed_dispatch']);
  });

  test('a long transit is a delayed delivery; shipped without tracking is flagged', () => {
    const shipped = new Date(+now - (SLA.deliveryDays + 1) * 24 * HOUR);
    const o = order({ status: 'shipped', packages: [pkg('shipped', { timeline: [{ status: 'shipped', at: shipped }] })] });
    assert.deepEqual(types(o).sort(), ['delayed_delivery', 'missing_tracking']);
  });

  test('failed refund and a paid-but-cancelled order', () => {
    const o = order({ status: 'cancelled', packages: [pkg('cancelled', { refund: { status: 'failed', amount: 100, error: 'timeout' } })] });
    assert.deepEqual(types(o).sort(), ['payment_mismatch', 'refund_failed']);
  });

  test('a paid order still holding its stock reservation', () => {
    assert.deepEqual(types(order({ reservation: { status: 'held', expiresAt: new Date(+now + HOUR) } })), ['stock_issue']);
  });
});

describe('refundSummary', () => {
  test('failed wins, and failed money is not counted as refunded', () => {
    const r = refundSummary({ packages: [pkg('cancelled', { refund: { status: 'processed', amount: 40 } }), pkg('cancelled', { refund: { status: 'failed', amount: 60 } })] });
    assert.deepEqual(r, { status: 'failed', amount: 40, failedAmount: 60 });
  });
});

describe('CSV export', () => {
  test('no customer PII, and formula-like cells are neutralised', () => {
    const csv = ordersCsv([order({ customer: { _id: 'c1', name: 'Asha', email: 'a@x.com' }, packages: [pkg('placed', { storeName: '=HYPERLINK("x")' })] })], now);
    assert.ok(!csv.includes('a@x.com') && !csv.includes('Asha'));
    assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  });
});
