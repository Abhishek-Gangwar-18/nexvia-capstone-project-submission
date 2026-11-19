import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end browser tests. They CHANGE DATA (orders, products, stores): run them only against a throwaway
 * stack with the demo seed and the built-in test gateway, never against Atlas.
 *
 *   BASE_URL=http://localhost:18080 ADMIN_EMAIL=... ADMIN_PASSWORD=... pnpm test
 */
export default defineConfig({
  testDir: './tests',
  // One browser at a time: the specs share one seeded database.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:18080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1366, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1366, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1366, height: 900 } } },
  ],
});
