import { test, expect, ACCOUNTS, signInFast } from './fixtures';
import { apiLogin } from './api';

test.describe('admin', () => {
  test.skip(!ACCOUNTS.admin.email, 'set ADMIN_EMAIL and ADMIN_PASSWORD');

  test('analytics charts and every console page load', async ({ page }) => {
    await signInFast(page, ACCOUNTS.admin, '/admin');
    await expect(page.getByText('Admin Console').first()).toBeVisible();
    await expect(page.locator('main svg.recharts-surface').first()).toBeVisible();
    for (const path of ['vendors', 'orders', 'products', 'users', 'coupons', 'categories', 'payments', 'returns', 'reviews', 'settings']) {
      await page.goto(`/admin/${path}`);
      await expect(page.locator('main h1, main h2').first()).toBeVisible();
    }
  });

  test('approve a new seller application', async ({ page, request }) => {
    // A new user applies to sell (API), the admin approves it in the console.
    const email = `e2e-seller-${Date.now().toString(36)}@example.com`;
    const reg = await request.post('/auth/register', { data: { name: 'E2E Seller', email, password: 'Test@1234' }, headers: { Accept: 'application/json' } });
    expect(reg.status()).toBe(201);
    const seller = await apiLogin(request, email, 'Test@1234');
    const storeName = `E2E Store ${Date.now().toString(36)}`;
    const onboard = await seller.call('POST', '/vendor/onboard', {
      storeName, email, phone: `97${String(Date.now()).slice(-8)}`,
      address: { line1: '1 Test Street', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
      bank: { accountHolder: 'E2E Seller', accountNumber: '123456789012', ifsc: 'HDFC0001234' },
    });
    expect(onboard.status, JSON.stringify(onboard.body)).toBe(201);

    await signInFast(page, ACCOUNTS.admin, '/admin/vendors');
    await page.getByPlaceholder('Search stores').fill(storeName);
    const card = page.locator('main').locator('div', { hasText: storeName }).filter({ has: page.getByRole('button', { name: /Approve/ }) }).last();
    await card.getByRole('button', { name: /Approve/ }).click();
    const dialog = page.getByRole('dialog');
    if (await dialog.isVisible().catch(() => false)) await dialog.getByRole('button', { name: /Approve/ }).last().click();
    await expect(page.getByText(/approved/i).first()).toBeVisible();

    // The store is now public
    const stores = await request.get(`/stores?q=${encodeURIComponent(storeName)}`, { headers: { Accept: 'application/json' } });
    expect((await stores.json()).total).toBe(1);
  });
});
