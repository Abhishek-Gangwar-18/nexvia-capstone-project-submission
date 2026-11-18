import { expect, type Locator, type Page } from "@playwright/test";

export const PASSWORD = "E2e-Pass-1234";
export const RUN = Date.now().toString(36);

/** A form Field's wrapper (label + control). Field labels aren't linked to inputs, so find them by label text. */
export function field(scope: Page | Locator, label: string): Locator {
  return scope.locator(`xpath=.//label[normalize-space()="${label}"]/..`).first();
}
export const input = (scope: Page | Locator, label: string) => field(scope, label).locator("input, textarea").first();

/** Headless UI Listbox inside a Field: open it and pick an option. */
export async function choose(page: Page, scope: Page | Locator, label: string, option: string) {
  await field(scope, label).locator("button").first().click();
  await pick(page, option);
}

/** Click a listbox option by its label (options may start with an avatar's initials, e.g. "KE Kim E2E"). */
export async function pick(page: Page, option: string) {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.getByRole("option", { name: new RegExp(`(^|\\s)${escaped}$`) }).first().click();
}

export async function toast(page: Page, text: string | RegExp) {
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: text }).first()).toBeVisible();
}

export async function register(page: Page, who: { first: string; email: string; workspace: string }) {
  await page.goto("/register");
  await input(page, "First name").fill(who.first);
  await input(page, "Last name").fill("E2E");
  await input(page, "Work email").fill(who.email);
  await input(page, "Password").fill(PASSWORD);
  await input(page, "Workspace name").fill(who.workspace);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/projects/);
}

export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\//);
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** An access token for API-only steps, through the same httpOnly cookie the page uses (rotates it). */
export async function accessToken(page: Page): Promise<string> {
  const res = await page.request.post("/api/auth/refresh/", { headers: { "X-Auth-Mode": "cookie" } });
  expect(res.status()).toBe(200);
  return (await res.json()).access;
}

/** In-app navigation by clicking the sidebar, like a user. (A full page load restores the session through
 *  /auth/refresh/, which is rate limited per IP at 30/min, so tests reload only where a reload is the point.) */
export async function go(page: Page, link: string) {
  if (link === "Profile & security") {
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: link }).click();
  } else {
    await page.getByRole("link", { name: link, exact: true }).first().click();
  }
  await page.waitForLoadState("networkidle");
}
