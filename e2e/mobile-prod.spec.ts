import { expect, test } from '@playwright/test';

/**
 * The full wall, on a phone, against the real deployment.
 *
 * The hermetic suite proves the behaviour and the smoke test proves the cameras
 * are alive; neither exercises the narrow layout against real HLS. That
 * combination is where this project's two riskiest tricks live: the wall is not
 * mounted at all below 700px, so every row draws its own picture from a decoder
 * that is two pixels wide and effectively invisible — a browser that declines to
 * decode it would show black thumbnails while every liveness pill stayed
 * correct, because those come from getVideoPlaybackQuality rather than from
 * anything drawn.
 *
 * Real cameras, so timings are generous and a single dead feed is not a failure.
 */

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function startWall(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('.roster__item').first()).toBeVisible();
  await page.getByRole('button', { name: /start monitoring/ }).first().click();
}

test('the wall is dropped entirely and the roster becomes the app', async ({ page }) => {
  await startWall(page);
  await expect(page.locator('.stage--list')).toBeVisible();
  await expect(page.locator('.wall canvas')).toHaveCount(0);
  // Nothing may scroll sideways on a phone.
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflows).toBe(false);
});

test('real cameras reach live and their row pictures are actually painting', async ({ page }) => {
  await startWall(page);

  const pills = page.locator('.roster__pick .pill');
  await expect
    .poll(async () => (await pills.allTextContents()).filter((t) => t.trim() === 'live').length,
      { timeout: 120_000, message: 'no camera reached live on mobile' })
    .toBeGreaterThan(0);

  /**
   * A thumbnail can lag its own pill. The pill comes from decoded-frame counts
   * via getVideoPlaybackQuality; the picture needs an actual drawImage of a
   * decoded frame at ~12fps. Reading the canvas the instant a pill turns live
   * catches a blank one, so poll for the paint rather than assuming it.
   */
  const litFraction = () => page.locator('.roster__thumb').evaluateAll((els) =>
    Math.max(...els.map((c) => {
      const canvas = c as HTMLCanvasElement;
      const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) n += 1;
      return n / (d.length / 4);
    })));

  await expect
    .poll(litFraction, { timeout: 60_000, message: 'no row thumbnail ever painted a picture' })
    .toBeGreaterThan(0.05);
  console.log(`[mobile] brightest thumbnail: ${Math.round((await litFraction()) * 100)}% lit`);
});

test('tapping a row promotes it to a full-width picture', async ({ page }) => {
  await startWall(page);
  const first = page.locator('.roster__item').first();
  const thumb = first.locator('.roster__thumb');
  const before = (await thumb.boundingBox())!.width;

  await first.locator('.roster__pick').tap();
  await expect(first).toHaveClass(/\bon\b/);
  await expect.poll(async () => (await thumb.boundingBox())!.width).toBeGreaterThan(before * 1.5);
});

test('freezing a feed from its row is caught by the watchdog', async ({ page }) => {
  await startWall(page);
  const row = page.locator('.roster__item').first();
  await expect(row.locator('.pill')).toHaveText('live', { timeout: 120_000 });

  await row.getByRole('button', { name: 'freeze' }).tap();
  await expect(row.locator('.pill')).toContainText('stale', { timeout: 60_000 });
  await expect(row.locator('.roster__inc')).not.toContainText('no incidents');
});

test('touch reorder controls work where drag-and-drop cannot', async ({ page }) => {
  await startWall(page);
  const names = () => page.locator('.roster__name').allTextContents();
  const before = await names();

  await page.locator('.roster__item').nth(1).getByRole('button', { name: /Move .* up/ }).tap();
  await expect.poll(names).not.toEqual(before);
  expect((await names())[0]).toBe(before[1]);
});

test('a feed can be escalated with its measurements, on a phone', async ({ page }) => {
  await startWall(page);
  await page.locator('.roster__item').first().getByRole('button', { name: /^report$/ }).tap();

  const dialog = page.getByRole('dialog', { name: 'Report incident' });
  await expect(dialog.locator('.evidence')).toContainText('decoded');
  await dialog.locator('textarea').fill('mobile production check');
  await dialog.getByRole('button', { name: 'Submit escalation' }).tap();

  await expect(page.locator('.strip')).toContainText('escalated1');
  await page.locator('.roster__item').first().locator('.roster__inspect').tap();
  await expect(page.getByRole('dialog')).toContainText('mobile production check');
});

test('search and the full report are usable at phone width', async ({ page }) => {
  await startWall(page);
  const all = await page.locator('.roster__name').allTextContents();

  await page.locator('.roster__search').fill(all[1]);
  await expect(page.locator('.roster__item')).toHaveCount(1);
  await page.locator('.roster__search').fill('');
  await expect(page.locator('.roster__item')).toHaveCount(all.length);

  await page.locator('.roster__item').first().locator('.roster__inspect').tap();
  const report = page.getByRole('dialog');
  await expect(report).toContainText('liveness');
  // The dialog must fit the viewport rather than overflowing it.
  const box = (await report.locator('.modal__panel').boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);
  await report.getByRole('button', { name: 'close' }).tap();
});

test('no console errors and no dead-watchdog banner', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await startWall(page);
  await page.waitForTimeout(20_000);

  await expect(page.locator('.banner')).toHaveCount(0);
  // Segment fetches against third-party CCTV can fail transiently; app-level
  // errors cannot.
  const appErrors = errors.filter((e) => !/Failed to load resource|net::ERR|\/g\/collect/.test(e));
  expect(appErrors).toEqual([]);
});
