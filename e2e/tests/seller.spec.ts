import { test, expect, ACCOUNTS, signInFast } from './fixtures';
import { paidOrderFor } from './api';
import type { Page } from '@playwright/test';

// Form fields: the label isn't linked to its input, so find the input inside the label's wrapper.
const field = (page: Page, label: string, tag = 'input, textarea, select') =>
  page.locator('div', { has: page.locator(`> label:text-is("${label}"), > label:has-text("${label}")`) }).locator(tag).first();

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.describe('seller', () => {
  test('dashboard, then publish a new product with an image', async ({ page }) => {
    await signInFast(page, ACCOUNTS.vendor, '/vendor');
    await expect(page.getByText('Seller Hub').first()).toBeVisible();
    await expect(page.locator('main svg').first()).toBeVisible(); // charts rendered

    await page.goto('/vendor/products');
    await page.getByRole('link', { name: /Add product/ }).or(page.getByRole('button', { name: /Add product/ })).first().click();
    await expect(page.getByRole('heading', { name: 'Add a new product' })).toBeVisible();

    const title = `E2E Product ${Date.now().toString(36)}`;
    await field(page, 'Product title').fill(title);
    const category = field(page, 'Category', 'select');
    await category.selectOption({ index: 1 });
    await field(page, 'Brand').fill('E2E Brand');
    await field(page, 'Description').fill('A product created by the end-to-end browser test.');
    await field(page, 'Selling price (₹)').fill('1499');
    await field(page, 'MRP (₹)').fill('1999');
    await field(page, 'Stock').fill('12');
    await page.locator('input[type=file]').first().setInputFiles({ name: 'product.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.locator('main img[src*="uploads"], main img[src*="amazonaws"]').first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Publish product' }).click();
    await expect(page).toHaveURL(/\/vendor\/products$/, { timeout: 15_000 });
    await page.getByPlaceholder('Search title, SKU, brand').fill(title);
    await expect(page.getByText(title).first()).toBeVisible();

    // It is live in the shop
    await page.goto(`/search?q=${encodeURIComponent(title)}`);
    await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();
  });

  test('a new paid order is packed, shipped and delivered', async ({ page, request }) => {
    const { orderNumber } = await paidOrderFor(request, ACCOUNTS.customer2, /TechNova/);
    await signInFast(page, ACCOUNTS.vendor, '/vendor/orders');
    await page.locator('main').getByText('All', { exact: true }).click();
    await page.getByPlaceholder('Search order number').fill(orderNumber);
    const row = page.locator('main').getByText(orderNumber).first();
    await expect(row).toBeVisible();
    await row.click(); // expand the package

    await page.getByRole('button', { name: 'Mark as packed' }).first().click();
    await expect(page.getByText(/marked packed/i).first()).toBeVisible();
    await page.getByRole('button', { name: 'Mark as shipped' }).first().click();
    // Ship dialog: tracking id is optional
    const confirm = page.getByRole('dialog').getByRole('button', { name: /ship/i }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    else await page.getByRole('button', { name: /^(Mark as )?shipped|Confirm|Ship package/i }).last().click();
    await expect(page.getByText(/marked shipped/i).first()).toBeVisible();
    await page.getByRole('button', { name: 'Mark as delivered' }).first().click();
    await expect(page.getByText(/Delivered!/).first()).toBeVisible();
  });

  test('payouts, reviews, coupons and returns pages load', async ({ page }) => {
    await signInFast(page, ACCOUNTS.vendor, '/vendor/payouts');
    for (const path of ['/vendor/payouts', '/vendor/reviews', '/vendor/coupons', '/vendor/returns', '/vendor/settings']) {
      await page.goto(path);
      await expect(page.locator('main h1, main h2').first()).toBeVisible();
    }
  });
});
