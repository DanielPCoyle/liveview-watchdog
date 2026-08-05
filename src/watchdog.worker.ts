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

interface Sample { at: number; media: number }

interface Entry {
  staleAfterMs: number;
  degradedAfterMs: number;
  lastFrameAt: number | null;
  samples: Sample[];
  idle: boolean;
}

const entries = new Map<string, Entry>();
const TICK_MS = 100;

/**
 * Drift is measured over a sliding window, not since the first frame ever.
 *
 * Frame arrival alone is not sufficient evidence of liveness. When a live
 * source dies, hls.js enters a reload loop: it retries the stalled playlist,
 * each attempt presents a frame or two, and `currentTime` resets to 0 each
 * cycle. Frames keep arriving — so a purely arrival-based watchdog sits at
 * "degraded" forever and never calls it — while the operator is shown the same
 * few seconds on repeat. Observed directly: a camera dead for two minutes still
 * reported frames every ~1.1s.
 *
 * Media time advancing in step with wall time is the signal that survives that.
 * A reload loop replays the same window, so windowed drift collapses toward 0.
 */
const DRIFT_WINDOW_MS = 6000;
const DRIFT_MIN_SPAN_MS = 2500;
const DRIFT_STALE_BELOW = 0.35;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'register':
      entries.set(msg.id, {
        staleAfterMs: msg.staleAfterMs,
        degradedAfterMs: msg.degradedAfterMs,
        lastFrameAt: null,
        samples: [],
        idle: true,
      });
      break;
    case 'unregister':
      entries.delete(msg.id);
      break;
    case 'idle': {
      const en = entries.get(msg.id);
      if (en) { en.idle = true; en.lastFrameAt = null; en.samples = []; }
      break;
    }
    case 'frame': {
      const en = entries.get(msg.id);
      if (!en) break;
      en.idle = false;
      en.lastFrameAt = msg.at;
      en.samples.push({ at: msg.at, media: msg.mediaTime });
      const cutoff = msg.at - DRIFT_WINDOW_MS;
      while (en.samples.length > 2 && en.samples[0].at < cutoff) en.samples.shift();
      break;
    }
  }
};

setInterval(() => {
  // Must match the main thread's clock — see the note in useTile.
  const now = Date.now();
  const out: FromWorker['entries'] = [];

  for (const [id, en] of entries) {
    let liveness: Liveness;
    let staleMs = 0;

    // Windowed media drift: how far the media clock moved per second of wall
    // clock, recently. ~1.0 healthy, ~0 for a feed that is not progressing.
    let drift: number | null = null;
    if (en.samples.length >= 2) {
      const first = en.samples[0];
      const last = en.samples[en.samples.length - 1];
      const wall = last.at - first.at;
      if (wall >= DRIFT_MIN_SPAN_MS) drift = ((last.media - first.media) * 1000) / wall;
    }

    if (en.idle || en.lastFrameAt == null) {
      liveness = 'idle';
    } else {
      staleMs = now - en.lastFrameAt;
      if (staleMs >= en.staleAfterMs) {
        liveness = 'stale';                       // frames stopped outright
      } else if (drift != null && drift < DRIFT_STALE_BELOW) {
        // Frames ARE arriving, but the content isn't moving — a player looping
        // on a dead source. Treated as signal loss, because to the operator it
        // is: what's on screen is not now.
        liveness = 'stale';
      } else {
        liveness = staleMs >= en.degradedAfterMs ? 'degraded' : 'live';
      }
    }

    out.push([id, liveness, Math.round(staleMs), drift == null ? null : +drift.toFixed(3)]);
  }

  if (out.length) (self as unknown as Worker).postMessage({ type: 'status', entries: out } satisfies FromWorker);
}, TICK_MS);
