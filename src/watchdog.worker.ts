/**
 * The watchdog runs OFF the main thread on purpose.
 *
 * A liveness check that lives on the main thread is a victim of the very jank
 * it is supposed to detect: if the main thread is blocked, a main-thread timer
 * doesn't fire either, so nothing notices that nothing is happening. Silence
 * gets interpreted as health.
 *
 * Here the worker owns the clock. The main thread only emits per-frame
 * heartbeats. If those heartbeats stop — because the feed froze, OR because the
 * page is too busy to report — this timer keeps running and says so.
 */
import type { ToWorker, FromWorker, Liveness } from './types';

interface Entry {
  staleAfterMs: number;
  degradedAfterMs: number;
  lastFrameAt: number | null;
  firstFrameAt: number | null;
  lastMediaTime: number | null;
  firstMediaTime: number | null;
  idle: boolean;
}

const entries = new Map<string, Entry>();
const TICK_MS = 100;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'register':
      entries.set(msg.id, {
        staleAfterMs: msg.staleAfterMs,
        degradedAfterMs: msg.degradedAfterMs,
        lastFrameAt: null,
        firstFrameAt: null,
        lastMediaTime: null,
        firstMediaTime: null,
        idle: true,
      });
      break;
    case 'unregister':
      entries.delete(msg.id);
      break;
    case 'idle': {
      const en = entries.get(msg.id);
      if (en) { en.idle = true; en.lastFrameAt = null; en.firstFrameAt = null; }
      break;
    }
    case 'frame': {
      const en = entries.get(msg.id);
      if (!en) break;
      en.idle = false;
      en.lastFrameAt = msg.at;
      en.lastMediaTime = msg.mediaTime;
      if (en.firstFrameAt == null) { en.firstFrameAt = msg.at; en.firstMediaTime = msg.mediaTime; }
      break;
    }
  }
};

setInterval(() => {
  const now = performance.now();
  const out: FromWorker['entries'] = [];

  for (const [id, en] of entries) {
    let liveness: Liveness;
    let staleMs = 0;

    if (en.idle || en.lastFrameAt == null) {
      liveness = 'idle';
    } else {
      staleMs = now - en.lastFrameAt;
      liveness = staleMs >= en.staleAfterMs ? 'stale'
        : staleMs >= en.degradedAfterMs ? 'degraded'
        : 'live';
    }

    // Media clock vs wall clock. A frozen feed keeps its last frame on screen
    // and reports readyState 4 with no error — but its media time stops moving.
    let drift: number | null = null;
    if (en.firstFrameAt != null && en.lastFrameAt != null && en.firstMediaTime != null && en.lastMediaTime != null) {
      const wall = en.lastFrameAt - en.firstFrameAt;
      if (wall > 500) drift = ((en.lastMediaTime - en.firstMediaTime) * 1000) / wall;
    }

    out.push([id, liveness, Math.round(staleMs), drift == null ? null : +drift.toFixed(3)]);
  }

  if (out.length) (self as unknown as Worker).postMessage({ type: 'status', entries: out } satisfies FromWorker);
}, TICK_MS);
