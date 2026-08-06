/**
 * The watchdog's decision logic, driven through its real message protocol.
 *
 * This is the file the entire project rests on: it decides what "live" means,
 * and it is pure — no DOM, no React, no I/O — so there is no excuse for it to
 * be covered only indirectly through a browser.
 *
 * Time is controlled rather than waited out. The worker reads `Date.now()` for
 * the current instant and takes frame timestamps from the messages it is sent,
 * so both sides are steerable and a six-second drift window costs milliseconds.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { FromWorker, Liveness, StaleReason, ToWorker } from './types';

const T0 = 1_700_000_000_000;

let sent: FromWorker[] = [];
let post: (m: ToWorker) => void;

/** Import the worker fresh so its interval and state belong to this test file. */
beforeEach(async () => {
  sent = [];
  setSystemTime(new Date(T0));
  (globalThis as unknown as { postMessage: unknown }).postMessage = (m: FromWorker) => sent.push(m);
  await import('./watchdog.worker');
  post = (m: ToWorker) => (globalThis as unknown as { onmessage: (e: { data: ToWorker }) => void })
    .onmessage({ data: m });
});

afterEach(() => setSystemTime());

/** Let the worker's 100ms interval fire at least once, then read the latest. */
async function tick(): Promise<Map<string, { liveness: Liveness; staleMs: number; drift: number | null; reason: StaleReason | null }>> {
  sent = [];
  await new Promise((r) => setTimeout(r, 130));
  const out = new Map<string, { liveness: Liveness; staleMs: number; drift: number | null; reason: StaleReason | null }>();
  for (const [id, liveness, staleMs, drift, reason] of sent.at(-1)?.entries ?? []) {
    out.set(id, { liveness, staleMs, drift, reason });
  }
  return out;
}

const register = (id: string) =>
  post({ type: 'register', id, staleAfterMs: 1200, degradedAfterMs: 400 });

describe('watchdog worker', () => {
  test('a registered feed with no frames yet is idle, not stale', async () => {
    register('a');
    const s = await tick();
    expect(s.get('a')?.liveness).toBe('idle');
    // Nothing has been claimed about this feed, which is different from
    // claiming it is dead — an unstarted feed must not raise an incident.
    expect(s.get('a')?.reason).toBeNull();
  });

  test('frames arriving in step with wall clock read live, with drift near 1.0', async () => {
    register('a');
    // Six seconds of healthy history: media advances exactly as fast as time.
    for (let i = 0; i <= 60; i++) {
      post({ type: 'frame', id: 'a', at: T0 + i * 100, mediaTime: i * 0.1 });
    }
    setSystemTime(new Date(T0 + 6000));
    const s = await tick();
    expect(s.get('a')?.liveness).toBe('live');
    expect(s.get('a')?.drift).toBeGreaterThan(0.9);
    expect(s.get('a')?.drift).toBeLessThan(1.1);
  });

  test('frames stopping outright is reported as the FRAMES failure', async () => {
    register('a');
    for (let i = 0; i <= 60; i++) {
      post({ type: 'frame', id: 'a', at: T0 + i * 100, mediaTime: i * 0.1 });
    }
    // Two seconds of silence, well past staleAfterMs.
    setSystemTime(new Date(T0 + 6000 + 2000));
    const s = await tick();
    expect(s.get('a')?.liveness).toBe('stale');
    expect(s.get('a')?.reason).toBe('frames');
    expect(s.get('a')?.staleMs).toBeGreaterThanOrEqual(1200);
  });

  /**
   * The claim the whole project exists to make: frames arriving at full rate,
   * a near-zero frame gap, and still dead.
   */
  test('frames arriving with a frozen media clock is reported as the DRIFT failure', async () => {
    register('a');
    for (let i = 0; i <= 30; i++) {
      post({ type: 'frame', id: 'a', at: T0 + i * 100, mediaTime: i * 0.1 });
    }
    // Frames keep coming at the same cadence; media time stops advancing.
    const frozenAt = 3.0;
    for (let i = 31; i <= 90; i++) {
      post({ type: 'frame', id: 'a', at: T0 + i * 100, mediaTime: frozenAt });
    }
    setSystemTime(new Date(T0 + 9000 + 20));
    const s = await tick();
    expect(s.get('a')?.liveness).toBe('stale');
    expect(s.get('a')?.reason).toBe('drift');
    expect(s.get('a')?.drift).toBeLessThan(0.35);
    // The distinguishing detail: frames are current.
    expect(s.get('a')?.staleMs).toBeLessThan(1200);
  });

  test('a gap longer than degradedAfterMs but shorter than stale reads degraded', async () => {
    register('a');
    for (let i = 0; i <= 60; i++) {
      post({ type: 'frame', id: 'a', at: T0 + i * 100, mediaTime: i * 0.1 });
    }
    setSystemTime(new Date(T0 + 6000 + 600));
    const s = await tick();
    expect(s.get('a')?.liveness).toBe('degraded');
  });

  test('drift is not computed until the window spans enough time to mean anything', async () => {
    register('a');
    // Only 1s of samples: shorter than DRIFT_MIN_SPAN_MS.
    for (let i = 0; i <= 10; i++) {
      post({ type: 'frame', id: 'a', at: T0 + i * 100, mediaTime: 0 });
    }
    setSystemTime(new Date(T0 + 1000));
    const s = await tick();
    // A frozen media clock over one second is not yet evidence of anything.
    expect(s.get('a')?.drift).toBeNull();
    expect(s.get('a')?.liveness).toBe('live');
  });

  test('idle resets a feed so a remount does not inherit the old verdict', async () => {
    register('a');
    for (let i = 0; i <= 60; i++) {
      post({ type: 'frame', id: 'a', at: T0 + i * 100, mediaTime: i * 0.1 });
    }
    setSystemTime(new Date(T0 + 20_000));
    expect((await tick()).get('a')?.liveness).toBe('stale');

    post({ type: 'idle', id: 'a' });
    const s = await tick();
    expect(s.get('a')?.liveness).toBe('idle');
    expect(s.get('a')?.staleMs).toBe(0);
  });

  test('unregister stops reporting on a feed entirely', async () => {
    register('a');
    register('b');
    expect((await tick()).size).toBe(2);
    post({ type: 'unregister', id: 'a' });
    const s = await tick();
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(true);
  });

  test('feeds are judged independently', async () => {
    register('healthy');
    register('dead');
    for (let i = 0; i <= 60; i++) {
      post({ type: 'frame', id: 'healthy', at: T0 + i * 100, mediaTime: i * 0.1 });
      if (i < 10) post({ type: 'frame', id: 'dead', at: T0 + i * 100, mediaTime: i * 0.1 });
    }
    setSystemTime(new Date(T0 + 6000));
    const s = await tick();
    expect(s.get('healthy')?.liveness).toBe('live');
    expect(s.get('dead')?.liveness).toBe('stale');
  });

  test('a frame for an unknown id is ignored rather than throwing', async () => {
    register('a');
    expect(() => post({ type: 'frame', id: 'ghost', at: T0, mediaTime: 0 })).not.toThrow();
    expect(() => post({ type: 'idle', id: 'ghost' })).not.toThrow();
    expect((await tick()).has('ghost')).toBe(false);
  });
});
