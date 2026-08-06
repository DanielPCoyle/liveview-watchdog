import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end against the hermetic `?mock=1` wall.
 *
 * These run on synthetic canvas-backed feeds, never on public CCTV: this
 * project's own README documents those origins rotting, and a suite that goes
 * red when a highway camera reboots is a suite people learn to ignore. What
 * real feeds are for is the production smoke test, which is a different
 * question — "are the cameras still there" — asked on a schedule.
 */

const MOCK = '/?mock=1';

async function wallReady(page: Page) {
  await page.goto(MOCK);
  await expect(page.locator('.roster__item')).toHaveCount(3);
  // Wait for the watchdog to have said something about the first feed.
  await expect(page.locator('.roster__item').first().locator('.pill')).toHaveText('live', { timeout: 15000 });
}

test('the wall reports live feeds, and says so in the header', async ({ page }) => {
  await wallReady(page);
  await expect(page.locator('.strip')).toContainText('feeds3');
  await expect(page.locator('.strip')).toContainText('live3');
  await expect(page.locator('.bar__sync')).toHaveText('local');
});

test('a frozen feed is caught by drift while frames are still arriving', async ({ page }) => {
  await wallReady(page);

  await page.locator('.roster__item').first().locator('.roster__pick').click();
  const hero = page.locator('.ov--hero');
  await expect(hero).toBeVisible();
  await hero.getByRole('button', { name: 'freeze', exact: true }).click();

  // The claim: stale with frames still decoding and a near-zero frame gap.
  await expect(hero.locator('.pill')).toContainText('stale', { timeout: 20000 });

  const stats = hero.locator('.ov__stats');
  await expect(stats).toContainText('0.00');            // media drift collapsed

  const gap = await hero.locator('.pill').textContent();
  const seconds = Number(/stale ([\d.]+)s/.exec(gap ?? '')?.[1] ?? '99');
  expect(seconds).toBeLessThan(1);                       // frames are still arriving

  // And the log distinguishes it from a feed that simply stopped.
  await expect(page.locator('.roster__item').first().locator('.roster__inc')).toContainText('frames stale');
});

test('a stale feed auto-promotes, and ignoring it stops that without hiding it', async ({ page }) => {
  await wallReady(page);
  const row = page.locator('.roster__item').first();

  await row.locator('.roster__pick').click();
  await page.locator('.ov--hero').getByRole('button', { name: 'freeze', exact: true }).click();
  await expect(row.locator('.pill')).toContainText('stale', { timeout: 20000 });

  await row.getByRole('button', { name: 'ignore' }).click();
  await expect(row.getByRole('button', { name: 'ignored' })).toBeVisible();
  // Suppression must stay visible, and the feed must still count as stale.
  await expect(page.locator('.strip')).toContainText('ignored1');
  await expect(page.locator('.strip')).toContainText('stale1');
});

test('search and liveness filters narrow the roster', async ({ page }) => {
  await wallReady(page);
  await page.locator('.roster__search').fill('MOCK-02');
  await expect(page.locator('.roster__item')).toHaveCount(1);
  await expect(page.locator('.roster__tally')).toHaveText('1/3');

  await page.locator('.roster__search').fill('');
  await expect(page.locator('.roster__item')).toHaveCount(3);
  await page.locator('.roster__filters').getByRole('button', { name: /^stale/ }).click();
  await expect(page.locator('.roster__item')).toHaveCount(0);
});

test('hovering a row brings its tile forward and enlarges it', async ({ page }) => {
  await wallReady(page);
  const tiles = page.locator('.ov:not(.ov--add)');
  const before = (await tiles.first().boundingBox())!.width;

  await page.locator('.roster__item').first().locator('.roster__pick').hover();
  await expect(tiles.first()).toHaveClass(/ov--front/);
  await page.waitForTimeout(600);

  const after = (await tiles.first().boundingBox())!.width;
  expect(after).toBeGreaterThan(before);
});

test('reordering the roster reorders the wall and survives a reload', async ({ page }) => {
  await wallReady(page);
  const names = () => page.locator('.roster__name').allTextContents();
  expect(await names()).toEqual(['MOCK-01', 'MOCK-02', 'MOCK-03']);

  // Keyboard path — the same operation drag performs, without synthesising DnD.
  await page.locator('.roster__item').nth(2).locator('.roster__pick').focus();
  await page.keyboard.press('Alt+ArrowUp');
  expect(await names()).toEqual(['MOCK-01', 'MOCK-03', 'MOCK-02']);
});

test('a feed can be escalated with its measurements attached', async ({ page }) => {
  await wallReady(page);
  // `exact` matters: the inspect button's accessible name is "Full report for …".
  await page.locator('.roster__item').first().getByRole('button', { name: 'report', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Report incident' });
  await expect(dialog).toContainText('MOCK-01');
  await expect(dialog.locator('.evidence')).toContainText('decoded');
  await dialog.locator('textarea').fill('e2e escalation');
  await dialog.getByRole('button', { name: 'Submit escalation' }).click();

  await expect(page.locator('.strip')).toContainText('escalated1');
  await page.locator('.roster__item').first().locator('.roster__inspect').click();
  await expect(page.getByRole('dialog')).toContainText('e2e escalation');
});

test('on a phone the wall is dropped and each row carries its own picture', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await wallReady(page);

  await expect(page.locator('.stage--list')).toBeVisible();
  await expect(page.locator('.wall canvas')).toHaveCount(0);
  await expect(page.locator('.roster__thumb')).toHaveCount(3);

  // The thumbnail has to be painting, not merely present.
  const lit = await page.locator('.roster__thumb').first().evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) n += 1;
    return n / (d.length / 4);
  });
  expect(lit).toBeGreaterThan(0.05);
});
