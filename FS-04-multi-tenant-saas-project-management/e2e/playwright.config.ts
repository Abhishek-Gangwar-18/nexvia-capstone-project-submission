import { defineConfig, devices } from "@playwright/test";

// Run against an isolated stack, never your development data: the tests register users, create workspaces,
// projects, issues, webhooks and reports. See e2e/README.md.
export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // flows share demo accounts, and login is rate limited per IP (5/min)
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:18081",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
});
