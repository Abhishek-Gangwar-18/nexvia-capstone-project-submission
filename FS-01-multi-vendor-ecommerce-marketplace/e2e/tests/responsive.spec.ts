import { test, expect, ACCOUNTS, signIn, accessToken } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Every key page at phone, tablet and desktop width, light and dark: no horizontal overflow, and a
 * screenshot for review in test-results/responsive/. Chromium only (layout is engine-independent enough;
 * the flows themselves run in all three engines).
 */
const SIZES = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];
const SCHEMES = ['light', 'dark'] as const;

async function overflow(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.right > width + 1 && style.position !== 'fixed' && !el.closest('[class*="overflow-x-auto"], [class*="overflow-x-scroll"], [class*="overflow-hidden"], [class*="snap-x"]');
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} right=${Math.round(el.getBoundingClientRect().right)}`);
    return { scroll: document.documentElement.scrollWidth, width, wide };
  });
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test(`${size.name} ${scheme}: pages fit the screen`, async ({ browser, browserName }) => {
      test.skip(browserName !== 'chromium', 'layout checked in Chromium');
      test.setTimeout(180_000);
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, isMobile: size.name === 'phone', hasTouch: size.name !== 'desktop' });
      const page = await context.newPage();
      const problems: string[] = [];
      const check = async (label: string, path?: string) => {
        if (path) await page.goto(path);
        // Signed-in pages keep a live event stream open, so the network never goes fully idle.
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
        const o = await overflow(page);
        if (o.scroll > o.width + 1) problems.push(`${label}: page is ${o.scroll}px wide on a ${o.width}px screen (${o.wide.join(' | ')})`);
        await page.screenshot({ path: `test-results/responsive/${size.name}-${scheme}-${label}.png`, fullPage: false });
      };

      const product = await page.request.get('/products?q=iphone&limit=1', { headers: { Accept: 'application/json' } }).then((r) => r.json());
      await check('home', '/');
      await check('search', '/search?q=phone');
      await check('product', `/product/${product.items[0]._id}`);
      await check('stores', '/stores');
      await check('cart', '/cart');
      await check('notfound', '/no-such-page');

      await signIn(page, ACCOUNTS.customer);
      await check('orders', '/orders');
      await check('account', '/account');
      // Through the API (sets the cart to 1 item whatever earlier runs left in it).
      const token = await accessToken(page);
      await page.request.post('/cart/items', {
        data: { productId: product.items[0]._id, quantity: 1 },
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-Requested-With': 'vendora' },
      });
      await check('checkout', '/checkout');
      await context.clearCookies();

      await signIn(page, ACCOUNTS.vendor);
      await check('seller-dashboard', '/vendor');
      await check('seller-orders', '/vendor/orders');
      await check('seller-product-form', '/vendor/products/new');
      await context.clearCookies();

      if (ACCOUNTS.admin.email) {
        await signIn(page, ACCOUNTS.admin);
        await check('admin-analytics', '/admin');
        await check('admin-orders', '/admin/orders');
        await check('admin-vendors', '/admin/vendors');
      }
      await context.close();
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
}
