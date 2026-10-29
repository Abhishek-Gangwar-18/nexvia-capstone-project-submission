/**
 * Payment safety checks: the test gateway is refused in production, and an order is only paid for a
 * succeeded PaymentIntent of this order and amount. Stripe is replaced by a fake; nothing is sent.
 * Run: pnpm test
 */
import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const src = (path) => new URL(`../src/${path}`, import.meta.url).href;

let intent;
let captured = 0;
mock.module('stripe', {
  defaultExport: class FakeStripe {
    paymentIntents = {
      retrieve: async () => ({ ...intent }),
      capture: async () => {
        captured += 1;
        return { ...intent, status: 'succeeded' };
      },
    };
  },
});

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake';
process.env.STRIPE_CURRENCY = 'inr';
const { confirmCapture } = await import(src('services/payment.js'));

const ORDER = { provider: 'stripe', orderId: 'order_1', amount: 1499.5 };

beforeEach(() => {
  intent = {
    id: 'pi_1',
    metadata: { orderId: 'order_1' },
    amount: 149950,
    currency: 'inr',
    status: 'succeeded',
    latest_charge: { id: 'ch_1', payment_method_details: { type: 'card' } },
  };
  captured = 0;
});

describe('confirmCapture', () => {
  test('a succeeded payment of the right order and amount passes', async () => {
    assert.deepEqual(await confirmCapture('pi_1', ORDER), { method: 'card', chargeId: 'ch_1' });
  });

  test('a payment waiting for manual capture is captured first', async () => {
    intent.status = 'requires_capture';
    assert.deepEqual(await confirmCapture('pi_1', ORDER), { method: 'card', chargeId: 'ch_1' });
    assert.equal(captured, 1);
  });

  for (const status of ['requires_payment_method', 'processing', 'canceled']) {
    test(`a ${status} payment is rejected`, async () => {
      intent.status = status;
      await assert.rejects(confirmCapture('pi_1', ORDER), (err) => err.status === 402);
    });
  }

  test('a payment for a different order is rejected', async () => {
    intent.metadata.orderId = 'order_other';
    await assert.rejects(confirmCapture('pi_1', ORDER), (err) => err.status === 400);
  });

  test('a payment for a different amount or currency is rejected', async () => {
    intent.amount = 100;
    await assert.rejects(confirmCapture('pi_1', ORDER), /does not match/);
    intent.amount = 149950;
    intent.currency = 'usd';
    await assert.rejects(confirmCapture('pi_1', ORDER), /does not match/);
  });
});

describe('test gateway in production', () => {
  test('the server refuses to start without Stripe keys unless explicitly allowed', async () => {
    const script = (allow) => `
      process.env.NODE_ENV = 'production';
      process.env.STRIPE_SECRET_KEY = '';
      process.env.STRIPE_PUBLISHABLE_KEY = '';
      process.env.ALLOW_TEST_GATEWAY = '${allow}';
      const { assertPaymentConfig } = await import(${JSON.stringify(src('services/payment.js'))});
      try { assertPaymentConfig(); console.log('started'); } catch (e) { console.log('refused'); }`;
    const { execFileSync } = await import('node:child_process');
    const run = (allow) => execFileSync(process.execPath, ['--input-type=module', '-e', script(allow)], { encoding: 'utf8' }).trim().split('\n').pop();
    assert.equal(run('false'), 'refused');
    assert.equal(run('true'), 'started');
  });
});
