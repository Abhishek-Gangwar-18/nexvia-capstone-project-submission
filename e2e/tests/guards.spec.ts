import { test, expect, ACCOUNTS, signIn, signInFast } from './fixtures';

test.describe('access and failure paths', () => {
  test('a wrong password shows an error and keeps the dialog open', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Email' }).fill(ACCOUNTS.customer.email);
    await dialog.getByRole('textbox', { name: 'Password' }).fill('wrong-password');
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(dialog.getByText(/Incorrect email or password/)).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('a new shopper can create an account and sign out', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Join' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await dialog.getByPlaceholder('Aarav Patel').fill('E2E Shopper');
    await dialog.getByPlaceholder('you@example.com').fill(`e2e-${Date.now().toString(36)}@example.com`);
    await dialog.getByPlaceholder('At least 8 characters').fill('Test@1234');
    await dialog.getByRole('button', { name: /create account|sign up|join/i }).last().click();
    await expect(page.getByRole('button', { name: /Hello, E2E/ })).toBeVisible();

    await page.getByRole('button', { name: /Hello, E2E/ }).click();
    await page.getByRole('menuitem', { name: /sign out|log out/i }).or(page.getByRole('button', { name: /sign out|log out/i })).first().click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('a guest opening checkout or orders is asked to sign in', async ({ page }) => {
    for (const path of ['/checkout', '/orders']) {
      await page.goto(path);
      await expect(page.getByRole('dialog').getByRole('heading', { name: 'Welcome back' }).or(page.getByRole('button', { name: 'Sign in' })).first()).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toHaveCount(0);
    }
  });

  test('a customer cannot open the admin console or the seller hub', async ({ page }) => {
    await signInFast(page, ACCOUNTS.customer, '/admin');
    await expect(page.getByText('Admin Console')).toHaveCount(0);
    await page.goto('/vendor/products');
    await expect(page.getByRole('heading', { name: 'Add a new product' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Search title, SKU, brand')).toHaveCount(0);
  });

  test('an unknown page shows the not-found screen', async ({ page }) => {
    await page.goto('/this-page-does-not-exist');
    await expect(page.getByText(/not found|404|doesn.t exist/i).first()).toBeVisible();
  });

  test('an out-of-stock product cannot be added to the cart', async ({ page, request }) => {
    const res = await request.get('/products?limit=48', { headers: { Accept: 'application/json' } });
    const out = (await res.json()).items.find((p) => p.stock === 0);
    test.skip(!out, 'no out-of-stock product in the seed');
    await signIn(page, ACCOUNTS.customer);
    await page.goto(`/product/${out._id}`);
    await expect(page.getByRole('heading', { level: 1, name: out.title })).toBeVisible();
    // The main buy box (the related-product cards below have their own "Add" buttons)
    const add = page.locator('main button', { hasText: /^\s*Add to cart\s*$/ }).first();
    await expect(page.getByText(/out of stock/i).first()).toBeVisible();
    if (await add.count()) await expect(add).toBeDisabled();
  });
});
