/**
 * The storage facade. Two real drivers behind one interface, so the tests that
 * matter are the seams: which driver gets chosen, and what happens when the
 * remote one fails. A shared wall that cannot reach its backend has to degrade
 * to a working private wall — never to a blank screen — and that is a promise
 * worth a test rather than a comment.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Registry } from './feeds';

const REG: Registry = { groups: [{ id: 'g1', name: 'One' }], feeds: [] };

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');   // see note in feeds.test.ts
});
afterEach(() => { mock.restore(); });

describe('local driver (the default)', () => {
  test('is chosen when Firebase is not configured', async () => {
    const { createSync, firebaseConfigured } = await import('./sync');
    expect(firebaseConfigured()).toBe(false);
    expect((await createSync()).mode).toBe('local');
  });

  test('subscribe delivers the current registry immediately', async () => {
    const { createSync } = await import('./sync');
    const driver = await createSync();
    let got: Registry | null = null;
    const stop = driver.subscribe((r) => { got = r; });
    expect(got).not.toBeNull();
    expect(Array.isArray(got!.groups)).toBe(true);
    stop();
  });

  test('publish persists, and a change from another tab is picked up', async () => {
    const { createSync } = await import('./sync');
    const driver = await createSync();
    const seen: Registry[] = [];
    const stop = driver.subscribe((r) => seen.push(r));

    driver.publish(REG);
    expect(JSON.parse(localStorage.getItem('liveview-watchdog:registry:v3')!)).toEqual(REG);

    // Another tab is the nearest thing localStorage has to another operator.
    localStorage.setItem('liveview-watchdog:registry:v3', JSON.stringify(REG));
    window.dispatchEvent(new StorageEvent('storage', { key: 'liveview-watchdog:registry:v3' }));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toEqual(REG);
    stop();
  });

  test('unsubscribing stops delivery', async () => {
    const { createSync } = await import('./sync');
    const driver = await createSync();
    const seen: Registry[] = [];
    driver.subscribe((r) => seen.push(r))();
    const n = seen.length;
    window.dispatchEvent(new StorageEvent('storage', { key: 'liveview-watchdog:registry:v3' }));
    expect(seen.length).toBe(n);
  });
});
