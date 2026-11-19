import { test as base, expect, type Page } from '@playwright/test';

export const ACCOUNTS = {
  customer: { email: 'customer@vendora.dev', password: 'Customer@123', greeting: /Hello, Aarav/ },
  customer2: { email: 'ananya.gupta@example.com', password: 'Customer@123', greeting: /Hello, Ananya/ },
  vendor: { email: 'technova@vendora.dev', password: 'Vendor@123' },
  admin: { email: process.env.ADMIN_EMAIL || '', password: process.env.ADMIN_PASSWORD || '' },
};

/** Fails the test on any uncaught page error or console error (ignoring expected 4xx answers the UI handles). */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        // The browser logs every non-2xx fetch; the specs assert on what the UI shows instead.
        if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
        if (/status of 4\d\d|40[0-9] \(|409|401|403|404/.test(text) && /Failed to load resource|fetch/i.test(text)) return;
        // Firefox reports a web font download cancelled by a page navigation (NS_BINDING_ABORTED) as an error.
        if (/downloadable font: download failed .*status=2152398850/.test(text)) return;
        errors.push(`console: ${text}`);
      });
      await use(errors);
      expect(errors, 'browser console errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** Signs in through the UI's "Sign in" dialog. */
export async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/');
  const dialog = page.getByRole('dialog');
  const headerSignIn = page.getByRole('button', { name: 'Sign in' });
  if (await headerSignIn.isVisible()) await headerSignIn.click();
  else {
    // Phones show only "Join" in the header; its dialog switches to sign in.
    await page.getByRole('button', { name: 'Join' }).click();
    await dialog.getByRole('button', { name: /^Sign in$/ }).or(dialog.getByRole('link', { name: /^Sign in$/ })).last().click();
  }
  await dialog.getByRole('textbox', { name: 'Email' }).fill(who.email);
  await dialog.getByRole('textbox', { name: 'Password' }).fill(who.password);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Signs in through the UI, then opens `path`. */
export async function signInFast(page: Page, who: { email: string; password: string }, path = '/') {
  await signIn(page, who);
  await page.goto(path);
}

/** Empties the signed-in customer's cart through the API. */
export async function emptyCart(page: Page) {
  const token = await accessToken(page);
  await page.request.delete('/cart', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-Requested-With': 'vendora' } });
}

export async function accessToken(page: Page) {
  const res = await page.request.post('/auth/refresh', { headers: { Accept: 'application/json', 'X-Requested-With': 'vendora' } });
  return (await res.json()).accessToken as string;
}
