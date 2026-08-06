/**
 * The Realtime Database driver, with the Firebase SDK mocked.
 *
 * The promise being tested is the fallback: a shared wall that cannot reach its
 * backend must degrade to a working private wall, never to a blank screen. That
 * is the kind of guarantee that is easy to write in a comment and easy to break
 * silently, so it gets assertions.
 *
 * Env is set here rather than in a fixture because `sync` reads its config at
 * call time — see `fbConfig()`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Registry } from './feeds';

const REG: Registry = { groups: [{ id: 'g1', name: 'Shared' }], feeds: [] };

let onValueCb: ((snap: { val: () => unknown }) => void) | null = null;
let onValueErr: ((e: Error) => void) | null = null;
let written: unknown = null;
let setRejects = false;
let initThrows = false;

mock.module('firebase/app', () => ({
  initializeApp: (cfg: unknown) => {
    if (initThrows) throw new Error('bad firebase config');
    return { cfg };
  },
}));

mock.module('firebase/database', () => ({
  getDatabase: () => ({}),
  ref: (_db: unknown, path: string) => ({ path }),
  onValue: (
    _node: unknown,
    cb: (snap: { val: () => unknown }) => void,
    err: (e: Error) => void,
  ) => { onValueCb = cb; onValueErr = err; return () => { onValueCb = null; }; },
  set: async (_node: unknown, value: unknown) => {
    written = value;
    if (setRejects) throw new Error('permission denied');
  },
}));

function configure(on: boolean) {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  env.VITE_FIREBASE_DATABASE_URL = on ? 'https://demo.firebaseio.test' : undefined;
  env.VITE_FIREBASE_API_KEY = on ? 'key-123' : undefined;
  env.VITE_FIREBASE_PROJECT_ID = on ? 'demo' : undefined;
  env.VITE_FIREBASE_APP_ID = on ? 'app-1' : undefined;
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  onValueCb = null; onValueErr = null; written = null;
  setRejects = false; initThrows = false;
  configure(true);
});
afterEach(() => configure(false));

describe('firebase driver', () => {
  test('is selected once a database URL and key are present', async () => {
    const { createSync, firebaseConfigured } = await import('./sync');
    expect(firebaseConfigured()).toBe(true);
    expect((await createSync()).mode).toBe('firebase');
  });

  test('a remote registry is delivered to subscribers', async () => {
    const { createSync } = await import('./sync');
    const driver = await createSync();
    let got: Registry | null = null;
    driver.subscribe((r) => { got = r; });
    onValueCb!({ val: () => REG });
    expect(got).toEqual(REG);
  });

  /**
   * An empty node means "nobody has seeded this wall yet", not "the wall is
   * empty" — treating those the same would blank the grid for every operator.
   */
  test('an empty remote node falls back to local rather than wiping the wall', async () => {
    const { createSync } = await import('./sync');
    const driver = await createSync();
    let got: Registry | null = null;
    driver.subscribe((r) => { got = r; });

    onValueCb!({ val: () => null });
    expect(got!.groups.length).toBeGreaterThan(0);

    onValueCb!({ val: () => ({ groups: [], feeds: [] }) });
    expect(got!.groups.length).toBeGreaterThan(0);
  });

  test('publishing writes to the shared node AND keeps a local copy', async () => {
    const { createSync } = await import('./sync');
    const driver = await createSync();
    driver.publish(REG);
    expect(written).toEqual(REG);
    // The local copy is what stops a backend outage costing the operator their wall.
    expect(JSON.parse(localStorage.getItem('liveview-watchdog:registry:v3')!)).toEqual(REG);
  });

  test('a rejected write does not throw at the call site', async () => {
    setRejects = true;
    const original = console.error;
    console.error = () => {};
    try {
      const { createSync } = await import('./sync');
      const driver = await createSync();
      expect(() => driver.publish(REG)).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      console.error = original;
    }
  });

  test('a subscription error is reported rather than thrown', async () => {
    const original = console.error;
    const seen: unknown[] = [];
    console.error = (...a: unknown[]) => seen.push(a);
    try {
      const { createSync } = await import('./sync');
      (await createSync()).subscribe(() => {});
      onValueErr!(new Error('rtdb unreachable'));
    } finally {
      console.error = original;
    }
    expect(seen.length).toBe(1);
  });

  test('a failure to initialise degrades to a working private wall', async () => {
    initThrows = true;
    const original = console.error;
    console.error = () => {};
    try {
      const { createSync } = await import('./sync');
      const driver = await createSync();
      // The wall still works; it is simply no longer shared.
      expect(driver.mode).toBe('local');
      let got: Registry | null = null;
      driver.subscribe((r) => { got = r; });
      expect(got!.groups.length).toBeGreaterThan(0);
    } finally {
      console.error = original;
    }
  });

  test('unsubscribing detaches the remote listener', async () => {
    const { createSync } = await import('./sync');
    const driver = await createSync();
    const stop = driver.subscribe(() => {});
    expect(onValueCb).not.toBeNull();
    stop();
    expect(onValueCb).toBeNull();
  });
});
