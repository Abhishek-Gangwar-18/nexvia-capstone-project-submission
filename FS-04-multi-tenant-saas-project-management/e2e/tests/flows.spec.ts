import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { PASSWORD, RUN, choose, field, input, login, logout, go, pick, register, toast } from "./helpers";

// One owner walks through the product in order; invited teammates use their own browser contexts.
// Everything is created fresh with a per-run suffix, so the suite can be re-run on the same stack.
test.describe.configure({ mode: "serial" });

const owner = { first: "Olivia", email: `owner-${RUN}@e2e.test`, workspace: `E2E Co ${RUN}` };
const keeper = { first: "Kim", email: `kim-${RUN}@e2e.test` };     // stays a member
const leaver = { first: "Lee", email: `lee-${RUN}@e2e.test` };     // removed again
const NEW_PASSWORD = "E2e-New-5678";
let page: Page;
let slug = "";
let keeperCtx: BrowserContext;
let keeperPage: Page;
const KEY = "E2E";
let issueKey = "";
const consoleErrors: string[] = [];

async function acceptInvite(browser: Browser, url: string, who: { first: string; email: string }) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(url);
  await expect(p.getByRole("heading", { name: "Join your team" })).toBeVisible();
  await input(p, "First name").fill(who.first);
  await input(p, "Last name").fill("E2E");
  await input(p, "Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Create account & join" }).click();
  await expect(p).toHaveURL(/\/w\/[^/]+\/dashboard/);
  return { ctx, p };
}

async function invite(email: string): Promise<string> {
  await go(page, "Members");
  await page.getByRole("button", { name: "Invite people" }).click();
  const dialog = page.getByRole("dialog");
  await input(dialog, "Email address").fill(email);
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog.getByText(`We're emailing an invitation to ${email}`, { exact: false })).toBeVisible();
  const url = await dialog.locator("input[readonly]").inputValue();
  await dialog.getByRole("button", { name: "Done" }).click();
  return url;
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`${page.url()}: ${m.text()}`); });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()}: ${e.message}`));
});

test("1. authentication: register, login, refresh, reload, change password, logout", async () => {
  await register(page, owner);
  slug = page.url().match(/\/w\/([^/]+)\//)![1];

  // Reload: the session comes back from the httpOnly cookie (nothing is stored in localStorage).
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/projects`));
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("eyJ");
  const cookies = await page.context().cookies();
  const refresh = cookies.find((c) => c.name === "fb_refresh")!;
  expect(refresh.httpOnly).toBe(true);
  expect(refresh.sameSite).toBe("Strict");
  expect(await page.evaluate(() => document.cookie)).not.toContain("fb_refresh");

  // Refresh: the cookie rotates.
  const res = await page.request.post("/api/auth/refresh/", { headers: { "X-Auth-Mode": "cookie" } });
  expect(res.status()).toBe(200);
  expect(Object.keys(await res.json())).toEqual(["access"]);
  const rotated = (await page.context().cookies()).find((c) => c.name === "fb_refresh")!;
  expect(rotated.value).not.toBe(refresh.value);
  await page.reload();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();

  // Change password, then log out and back in with the new one.
  await go(page, "Profile & security");
  await input(page, "Current password").fill(PASSWORD);
  await input(page, "New password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Update password" }).click();
  await toast(page, "Password changed");
  await page.reload(); // still signed in with the new cookie
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();

  await logout(page);
  expect((await page.context().cookies()).find((c) => c.name === "fb_refresh" && c.value)).toBeUndefined();
  await page.goto(`/w/${slug}/projects`); // a real load: no session to restore after logout
  await expect(page).toHaveURL(/\/login\?next=/); // protected page after logout
  await login(page, owner.email, NEW_PASSWORD);
});

test("2. workspaces: create, switch, invite, change role, remove member", async ({ browser }) => {
  // Create a second workspace and switch back through the switcher.
  await go(page, "Projects");
  await page.getByRole("button", { name: new RegExp(`${owner.workspace}`) }).first().click();
  await page.getByRole("menuitem", { name: "Create workspace" }).click();
  const dialog = page.getByRole("dialog");
  await input(dialog, "Company or team name").fill(`Second ${RUN}`);
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await toast(page, `Welcome to Second ${RUN}`);
  await expect(page).not.toHaveURL(new RegExp(`/w/${slug}/`));
  await page.getByRole("button", { name: new RegExp(`Second ${RUN}`) }).first().click();
  await page.getByRole("menuitem", { name: new RegExp(owner.workspace) }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/`));

  // Invite two people; both accept through the invite link.
  const keeperUrl = await invite(keeper.email);
  const leaverUrl = await invite(leaver.email);
  ({ ctx: keeperCtx, p: keeperPage } = await acceptInvite(browser, keeperUrl, keeper));
  const left = await acceptInvite(browser, leaverUrl, leaver);
  await left.ctx.close();

  // Change a role, then remove the other member.
  await page.reload(); // the teammates joined in other browsers: load the current member list
  const leaverRow = page.getByRole("listitem").filter({ hasText: leaver.email });
  await leaverRow.locator("[aria-haspopup=listbox]").click();
  await page.getByRole("option", { name: "Viewer", exact: true }).click();
  await toast(page, /is now viewer/);
  await leaverRow.getByRole("button", { name: "Remove member" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await toast(page, "Member removed");
  await expect(page.getByText(leaver.email)).toHaveCount(0);
  await expect(page.getByText(keeper.email).first()).toBeVisible();
});

test("3. projects: create project (board included), configure workflow statuses", async () => {
  await go(page, "Projects");
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog");
  await input(dialog, "Name").fill("E2E Project");
  await input(dialog, "Key").fill(KEY);
  await dialog.getByRole("button", { name: "Scrum" }).click();
  await dialog.getByRole("button", { name: "Create project" }).click();
  await toast(page, "E2E Project is ready");

  // The board comes with the project.
  await page.getByRole("link", { name: /E2E Project$/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${KEY}/board`));
  await expect(page.getByText(/No active sprint/)).toBeVisible();

  // Regression (fixed): on a scrum board with no active sprint the tabs used to change the URL while the board stayed
  // on screen (BoardPage re-rendered forever). Walk the tabs without any reload.
  const tabs = page.locator("main nav");
  await tabs.getByRole("link", { name: "Backlog" }).click();
  await expect(page.getByRole("button", { name: "Create sprint" })).toBeVisible();
  await tabs.getByRole("link", { name: "Issues" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${KEY}/issues`));
  await expect(page.getByText("No active sprint")).toHaveCount(0);
  await tabs.getByRole("link", { name: "Board" }).click();
  await expect(page.getByText("No active sprint")).toBeVisible();
  await tabs.getByRole("link", { name: "Workflow" }).click();
  await expect(page.getByRole("button", { name: "Add status" })).toBeVisible();
  await page.getByRole("button", { name: "Add status" }).click();
  const names = page.getByLabel("Status name");
  await names.last().fill("QA Review");
  await page.getByRole("button", { name: "Save workflow" }).click();
  await toast(page, "Workflow saved");
  await page.reload();
  await expect(page.getByLabel("Status name").last()).toHaveValue("QA Review");
});

test("4 + 5. issues and sprints: create, assign, priority, move, comment, attach; sprint lifecycle", async () => {
  // Sprint first, so the new issue can go straight into it.
  await go(page, "Backlog");
  await page.getByRole("button", { name: "Create sprint" }).click();
  let dialog = page.getByRole("dialog");
  await input(dialog, "Name").fill("Sprint One");
  await dialog.getByRole("button", { name: "Create sprint" }).click();
  await toast(page, "Sprint One created");

  // Create issue (topbar Create button), assigned to the teammate, into the sprint.
  await page.getByRole("button", { name: /^Create/ }).first().click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Create issue").first()).toBeVisible();
  await input(dialog, "Summary").fill(`Checkout bug ${RUN}`);
  await choose(page, dialog, "Assignee", "Kim E2E");
  await choose(page, dialog, "Priority", "High");
  await choose(page, dialog, "Sprint", "Sprint One");
  await dialog.getByRole("button", { name: "Create issue" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: `${KEY}-` }).first()).toBeVisible();
  issueKey = (await page.locator("[data-sonner-toast]").filter({ hasText: `${KEY}-` }).first().innerText()).match(new RegExp(`${KEY}-\\d+`))![0];

  // Start the sprint.
  await page.reload();
  await page.getByRole("button", { name: "Start sprint" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Start sprint" }).click();
  await toast(page, "Sprint One started");

  // Issue drawer: change priority, move status, comment with a mention, upload a file.
  await go(page, "Board");
  await page.getByText(`Checkout bug ${RUN}`).click();
  const drawer = page.getByRole("dialog", { name: "Issue details" }); // the drawer's accessible name
  await expect(drawer).toBeAttached();
  await expect(drawer.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(drawer).toContainText(new RegExp(`${KEY}-[0-9]+`));
  issueKey = (await drawer.innerText()).match(new RegExp(`${KEY}-[0-9]+`))![0];
  await drawer.locator("xpath=.//dt[normalize-space()='Priority']/following-sibling::dd[1]//button").first().click();
  await pick(page, "Highest");
  await expect(drawer.locator("xpath=.//dt[normalize-space()='Priority']/following-sibling::dd[1]")).toContainText("Highest");
  await drawer.getByRole("button", { name: /^To Do$/ }).first().click();
  await pick(page, "In Progress");
  await expect(drawer.getByRole("button", { name: /^In Progress$/ }).first()).toBeVisible();

  await drawer.getByPlaceholder("Write a comment").fill(`Looks broken @${keeper.email}`);
  await drawer.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(drawer.getByText("Looks broken").first()).toBeVisible();

  await drawer.getByRole("button", { name: "Files", exact: true }).click();
  await drawer.locator("input[type=file]").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("e2e attachment") });
  await toast(page, "File uploaded");
  await expect(drawer.getByText("notes.txt")).toBeVisible();
  await drawer.getByRole("button", { name: "Close" }).first().click();

  // The move is persisted: after a reload the card is in the In Progress column.
  await page.reload();
  const inProgress = page.locator("h3", { hasText: /in progress/i }).locator("xpath=ancestor::*[.//h3][2]");
  await expect(page.getByText(`Checkout bug ${RUN}`)).toBeVisible();
  await expect(inProgress.getByText(`Checkout bug ${RUN}`)).toBeVisible();

  // Complete the sprint (open issue goes back to the backlog).
  await page.getByRole("button", { name: "Complete sprint" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Complete sprint" }).click();
  await toast(page, /Sprint One completed/);
});

test("6. automation: create webhook, trigger event, see the failed delivery, redeliver it", async () => {
  test.setTimeout(300_000); // retries back off for about two minutes before the delivery is marked failed
  await go(page, "Settings");
  await page.getByPlaceholder("Webhook name").fill("E2E hook");
  // .invalid never resolves (RFC 2606): the delivery fails without sending anything anywhere.
  await page.getByPlaceholder("https://example.com/hooks").fill("https://e2e-hook.invalid/receive");
  await page.getByLabel("issue.created").check();
  await page.getByRole("button", { name: "Add webhook" }).click();
  await toast(page, "Webhook added");
  await expect(page.getByText("Copy this signing secret now")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // Trigger an event: a signed test delivery.
  await page.getByRole("button", { name: "Send test event" }).click();
  await toast(page, "Test delivery queued");
  // Sending a test opens the delivery list, which updates itself while the delivery is in flight (no reload):
  // 1 attempt + 5 retries with 2–32 s backoff, then "failed".
  await expect(page.getByRole("button", { name: "Hide deliveries" })).toBeVisible();
  await expect(page.getByText("failed", { exact: true }).first()).toBeVisible({ timeout: 180_000 });

  // Retry from the UI: Redeliver queues a new attempt for the failed delivery (existing redelivery API).
  await page.getByRole("button", { name: "Redeliver webhook.test" }).first().click();
  await toast(page, "Redelivery queued");
  await expect(page.getByText(/pending|processing/).first()).toBeVisible();
});

test("7. billing: choose a plan, pay in Stripe test mode, subscription shows", async () => {
  test.setTimeout(180_000);
  await go(page, "Billing");
  await expect(page.getByText("Current plan").first()).toBeVisible();
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });

  // Stripe's hosted Checkout in sandbox (test) mode, inside an iframe, with Stripe's published test card.
  const stripe = page.frameLocator("iframe").first();
  await stripe.getByRole("textbox", { name: "Card number" }).fill("4242 4242 4242 4242", { timeout: 60_000 });
  await stripe.getByRole("textbox", { name: "Expiration (MM/YY)" }).fill("12 / 34");
  await stripe.getByRole("textbox", { name: "Security code" }).fill("123");
  await stripe.getByRole("textbox", { name: "Name on card" }).fill("Olivia E2E");
  await stripe.locator("#billingCountry").selectOption("US", { timeout: 3000 }).catch(() => {}); // when Stripe asks for it
  const zip = stripe.locator("#billingPostalCode");
  if (await zip.isVisible().catch(() => false)) await zip.fill("10001");
  await stripe.getByRole("button", { name: "Subscribe", exact: true }).click();

  await page.waitForURL(new RegExp(`localhost:\\d+/w/${slug}/billing`), { timeout: 90_000 });
  await toast(page, "You're on the Pro plan");
  await expect(page.getByRole("button", { name: "Current plan" }).first()).toBeVisible();
});

test("8. reports and notifications: generate, download, unread count", async () => {
  await go(page, "Reports");
  await page.getByRole("button", { name: /Workspace summary/ }).click();
  await page.getByRole("button", { name: "Generate report" }).click();
  await toast(page, "Report queued");
  const download = page.getByRole("button", { name: "Download CSV" }).first();
  await expect(download).toBeVisible({ timeout: 60_000 });
  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
  expect(file.suggestedFilename()).toMatch(/\.csv$/);

  // The teammate was assigned an issue and mentioned in a comment: unread notifications.
  await keeperPage.reload();
  const bell = keeperPage.getByRole("button", { name: "Notifications" });
  await expect(bell.locator("span")).toHaveText(/^([1-9]|9\+)$/);
  const before = await bell.locator("span").innerText();
  await bell.click();
  await expect(keeperPage.getByText(/\d+ unread/)).toBeVisible();
  await keeperPage.getByRole("button", { name: "Mark all read" }).click();
  await expect(bell.locator("span")).toHaveCount(0);
  expect(Number(before === "9+" ? 10 : before)).toBeGreaterThan(0);
  await keeperCtx.close();
});

test.afterAll(async () => {
  // Surface browser console errors seen during the owner's walkthrough.
  if (consoleErrors.length) console.log(`Console errors:\n${consoleErrors.join("\n")}`);
});
