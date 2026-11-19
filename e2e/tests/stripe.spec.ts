import { test, expect, ACCOUNTS, signIn, emptyCart } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Real Stripe TEST-mode checkout (no money moves). Needs the API running with sk_test_ keys and the
 * built-in gateway off. Run with STRIPE=1.
 */
test.describe('Stripe test-mode checkout', () => {
  test.skip(!process.env.STRIPE, 'set STRIPE=1 with Stripe test keys configured');
  test.setTimeout(120_000);

  async function openStripePayment(page: Page, query: string) {
    await signIn(page, ACCOUNTS.customer);
    await emptyCart(page);
    await page.goto(`/search?q=${query}`);
    await page.getByRole('button', { name: 'Add to cart' }).first().click();
    await expect(page.getByRole('button', { name: /^Cart, 1 item/ })).toBeVisible();
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Deliver here & continue' }).click();
    await page.getByRole('button', { name: /Place order & pay/ }).click();
    await expect(page.getByRole('dialog').getByText('Pay securely')).toBeVisible({ timeout: 20_000 });
    const frame = page.frameLocator('iframe[title*="Secure payment input"]').first();
    const cardTab = frame.getByRole('tab', { name: /card/i }).or(frame.getByRole('button', { name: /^card$/i }));
    if (await cardTab.count()) await cardTab.first().click();
    await expect(frame.locator('input[name="number"]')).toBeVisible({ timeout: 30_000 });
    return frame;
  }

  async function fillCard(frame, number: string) {
    await frame.locator('input[name="number"]').fill(number);
    await frame.locator('input[name="expiry"]').fill('12 / 34');
    await frame.locator('input[name="cvc"]').fill('123');
    const country = frame.locator('select[name="country"]');
    if (await country.count()) await country.selectOption('IN').catch(() => {});
    const postal = frame.locator('input[name="postalCode"]');
    if (await postal.count() && (await postal.isVisible())) await postal.fill('560001');
  }

  test('card 4242 4242 4242 4242 pays the order', async ({ page }) => {
    const frame = await openStripePayment(page, 'charger');
    await fillCard(frame, '4242424242424242');
    await page.getByRole('dialog').getByRole('button', { name: /^Pay ₹/ }).click();
    await expect(page).toHaveURL(/\/orders\/[a-f\d]{24}/, { timeout: 60_000 });
    await expect(page.getByText(/paid|placed|confirmed/i).first()).toBeVisible();
  });

  test('a declined card (4000 0000 0000 0002) shows the bank\'s message and stays unpaid', async ({ page }) => {
    const frame = await openStripePayment(page, 'sunglasses');
    await fillCard(frame, '4000000000000002');
    await page.getByRole('dialog').getByRole('button', { name: /^Pay ₹/ }).click();
    await expect(page.getByText(/declined/i).first()).toBeVisible({ timeout: 60_000 });
    await expect(page).not.toHaveURL(/\/orders\/[a-f\d]{24}/);
  });
});
