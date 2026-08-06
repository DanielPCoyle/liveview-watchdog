import { defineConfig, devices } from '@playwright/test';

/**
 * Hermetic end-to-end run: builds the app, serves the build, and drives it
 * against `?mock=1` synthetic feeds. No network, no third-party CCTV origin.
 *
 * The production target lives in playwright.smoke.config.ts, which asks a
 * different question against the real deployment.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'wall.spec.ts',
  // Video liveness is measured over seconds by design — the drift window alone
  // is six — so these are not sub-second assertions.
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
