import { defineConfig, devices } from '@playwright/test';

/**
 * Runs the smoke spec against the REAL deployment — no webServer, no mock.
 * The target is live public CCTV over the public internet, so the timeouts are
 * generous and a retry is allowed: one flaky segment fetch is not an incident.
 *
 *   npx playwright test --config playwright.smoke.config.ts
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'smoke.spec.ts',
  timeout: 150_000,
  expect: { timeout: 90_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: process.env.SMOKE_BASE_URL || 'https://liveview-watchdog-production.up.railway.app',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
