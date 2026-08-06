import { expect, test } from '@playwright/test';

/**
 * Production smoke test — deliberately NOT a health check.
 *
 * `curl` returning 200 for index.html is exactly the kind of green light this
 * project exists to distrust: the page can serve perfectly, the bundle can
 * execute, the shell can render, and every camera on the wall can be dead. A
 * smoke test that stops at 200 would be the naive check, shipped.
 *
 * So this asserts what the app itself asserts: that frames are advancing on a
 * real feed. It is the project's own thesis pointed at its own deployment, and
 * it is the thing that will actually catch the documented failure mode — these
 * public CCTV endpoints rot, and when they do the demo silently becomes a wall
 * of dead tiles.
 *
 * Tolerance is deliberate. Individual municipal cameras go down for legitimate
 * reasons, so a single dead feed is not an alert; *nothing* alive is.
 */

test('the deployed wall serves its shell', async ({ page }) => {
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  await expect(page.locator('.bar h1')).toHaveText('Liveview Watchdog');
  await expect(page.locator('.roster__item').first()).toBeVisible();
});

test('at least one real camera is actually advancing frames', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /start monitoring/ }).first().click();

  const pills = page.locator('.roster__pick .pill');
  await expect(pills.first()).toBeVisible();

  // Public HLS with ~10s segments needs real time to reach the live edge.
  await expect
    .poll(async () => (await pills.allTextContents()).filter((t) => t.trim() === 'live').length,
      { timeout: 90_000, message: 'no seeded camera ever reported live in production' })
    .toBeGreaterThan(0);

  const states = await pills.allTextContents();
  console.log(`[smoke] feed states: ${states.map((s) => s.trim()).join(' | ')}`);
});

test('the watchdog worker is running, not merely bundled', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /start monitoring/ }).first().click();

  // A dead worker leaves every feed at 'idle' forever: the wall renders, the
  // canvas composites, and nothing is being measured.
  await expect
    .poll(async () => (await page.locator('.roster__pick .pill').allTextContents())
      .some((t) => t.trim() !== 'idle'),
      { timeout: 60_000, message: 'every feed stayed idle — the watchdog never reported' })
    .toBe(true);

  await expect(page.locator('.banner')).toHaveCount(0);   // no "worker stopped"
  expect(failures).toEqual([]);
});
