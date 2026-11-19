import { test, expect, ACCOUNTS, signIn, emptyCart } from './fixtures';

test.describe('customer', () => {
  test('search, add to cart, apply a coupon, check out and pay, then download the invoice', async ({ page }) => {
    await signIn(page, ACCOUNTS.customer);
    await expect(page.getByRole('button', { name: ACCOUNTS.customer.greeting })).toBeVisible();
    await emptyCart(page);

    // Search from the header and open a product
    await page.getByRole('combobox', { name: 'Search' }).fill('iphone');
    await page.getByRole('combobox', { name: 'Search' }).press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: /Results for/ })).toBeVisible();
    await page.getByRole('heading', { name: 'iPhone 6', exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'iPhone 6' })).toBeVisible();

    await page.getByRole('button', { name: 'Add to cart' }).first().click();
    await expect(page.getByRole('button', { name: /^Cart, 1 item/ })).toBeVisible();

    // Cart: coupon
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: 'Shopping cart' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Coupon code' }).fill('FLAT250');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('button', { name: 'Remove coupon' })).toBeVisible();

    // Checkout
    await page.getByRole('button', { name: 'Proceed to checkout' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
    await page.getByRole('button', { name: 'Deliver here & continue' }).click();
    const place = page.getByRole('button', { name: /Place order & pay/ });
    await expect(place).toBeEnabled();
    await place.click();

    // Test gateway
    const pay = page.getByRole('button', { name: /^Pay ₹/ });
    await expect(pay).toBeVisible();
    await pay.click();
    await expect(page).toHaveURL(/\/orders\/[a-f\d]{24}/, { timeout: 20_000 });
    await expect(page.getByText(/placed|confirmed/i).first()).toBeVisible();

    // Invoice
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /invoice/i }).or(page.getByRole('link', { name: /invoice/i })).first().click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('a declined payment can be retried', async ({ page }) => {
    await signIn(page, ACCOUNTS.customer2);
    await emptyCart(page);
    await page.goto('/search?q=charger');
    await page.getByRole('button', { name: 'Add to cart' }).first().click();
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Deliver here & continue' }).click();
    await page.getByRole('button', { name: /Place order & pay/ }).click();

    await page.getByRole('button', { name: 'Simulate a declined payment' }).click();
    await expect(page.getByText(/declined/i).first()).toBeVisible();

    // Try again and pay
    const retry = page.getByRole('button', { name: /try again|retry/i });
    if (await retry.count()) await retry.first().click();
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await expect(page).toHaveURL(/\/orders\/[a-f\d]{24}/, { timeout: 20_000 });
  });

  test('wishlist, orders list and account pages load', async ({ page }) => {
    await signIn(page, ACCOUNTS.customer);
    await page.getByRole('link', { name: /^Wishlist, / }).click();
    await expect(page.locator('main')).toBeVisible();
    await page.goto('/orders');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.locator('main a[href^="/orders/"]').first().click();
    await expect(page).toHaveURL(/\/orders\/[a-f\d]{24}/);
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
