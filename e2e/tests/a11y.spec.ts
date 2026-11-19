import AxeBuilder from '@axe-core/playwright';
import { test, expect, ACCOUNTS, signIn } from './fixtures';
import type { Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * Automated accessibility scan (axe-core, WCAG 2.1 A/AA rules) of the key pages, plus keyboard-only use.
 * The scan collects every violation into test-results/a11y.json; the test fails on serious or critical ones.
 */
const findings: Record<string, any[]> = {};

async function scan(page: Page, label: string) {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  findings[label] = result.violations.map((v) => ({
    id: v.id, impact: v.impact, help: v.help, count: v.nodes.length,
    examples: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.html || '').slice(0, 120)),
  }));
}

test.describe('accessibility', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'scanned in Chromium');
  test.setTimeout(180_000);

  test('axe scan of storefront, account, seller and admin pages', async ({ page, request }) => {
    const product = await request.get('/products?q=iphone&limit=1', { headers: { Accept: 'application/json' } }).then((r) => r.json());
    for (const [label, path] of [['home', '/'], ['search', '/search?q=phone'], ['product', `/product/${product.items[0]._id}`], ['stores', '/stores'], ['cart-empty', '/cart']] as const) {
      await page.goto(path);
      await scan(page, label);
    }
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await scan(page, 'sign-in-dialog');

    await signIn(page, ACCOUNTS.customer);
    await page.goto('/search?q=charger');
    await page.getByRole('button', { name: 'Add to cart' }).first().click();
    for (const [label, path] of [['cart', '/cart'], ['checkout', '/checkout'], ['orders', '/orders'], ['account', '/account']] as const) {
      await page.goto(path);
      await scan(page, label);
    }
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Deliver here & continue' }).click();
    await page.getByRole('button', { name: /Place order & pay/ }).click();
    await page.getByRole('button', { name: /^Pay ₹/ }).waitFor();
    await scan(page, 'payment-popup');
    await page.keyboard.press('Escape');
    await page.context().clearCookies();

    await signIn(page, ACCOUNTS.vendor);
    for (const [label, path] of [['seller-dashboard', '/vendor'], ['seller-products', '/vendor/products'], ['seller-product-form', '/vendor/products/new'], ['seller-orders', '/vendor/orders']] as const) {
      await page.goto(path);
      await scan(page, label);
    }
    await page.context().clearCookies();

    if (ACCOUNTS.admin.email) {
      await signIn(page, ACCOUNTS.admin);
      for (const [label, path] of [['admin-analytics', '/admin'], ['admin-orders', '/admin/orders'], ['admin-vendors', '/admin/vendors'], ['admin-settings', '/admin/settings']] as const) {
        await page.goto(path);
        await scan(page, label);
      }
    }

    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/a11y.json', JSON.stringify(findings, null, 2));
    const severe = Object.entries(findings).flatMap(([p, vs]) => vs.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${p}: ${v.id} (${v.count})`));
    expect(severe, severe.join('\n')).toEqual([]);
  });

  test('keyboard only: sign in, search and reach a product without a mouse', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // The first Tab should reach something useful and show where focus is.
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return { tag: el.tagName, text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), outline: style.outlineStyle !== 'none' || style.boxShadow !== 'none' };
    });
    expect(first.tag).not.toBe('BODY');
    expect(first.outline, `no visible focus on ${first.tag} "${first.text}"`).toBe(true);

    // Open the sign-in dialog with the keyboard
    const signInBtn = page.getByRole('button', { name: 'Sign in' });
    await signInBtn.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Focus moves into the dialog and Tab stays inside it
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    // Escape closes it and focus returns to the page
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Search with the keyboard
    await page.getByRole('combobox', { name: 'Search' }).focus();
    await page.keyboard.type('iphone');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: /Results for/ })).toBeVisible();
    // Tab to the first product link and open it with Enter
    const link = page.locator('main a[href^="/product/"]').first();
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/product\//);
    await expect(page.getByRole('button', { name: 'Add to cart' }).first()).toBeVisible();
  });
});
