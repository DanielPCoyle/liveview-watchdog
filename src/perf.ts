import { useEffect, useRef, useState } from 'react';

export interface PerfSnapshot {
  longTasks: number;
  longestTaskMs: number;
  blockedMs: number;
}

/**
 * Long tasks are the honest measure of "the page can't keep up". They're also
 * why a main-thread liveness check is untrustworthy: during a 200ms task, a
 * main-thread timer simply doesn't run.
 */
export function useLongTasks(): PerfSnapshot {
  const [snap, setSnap] = useState<PerfSnapshot>({ longTasks: 0, longestTaskMs: 0, blockedMs: 0 });
  const acc = useRef({ longTasks: 0, longestTaskMs: 0, blockedMs: 0 });

  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return;
    let obs: PerformanceObserver | null = null;
    try {
      obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          acc.current.longTasks += 1;
          acc.current.longestTaskMs = Math.max(acc.current.longestTaskMs, e.duration);
          // "Blocking time" convention: everything past the 50ms budget.
          acc.current.blockedMs += Math.max(0, e.duration - 50);
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
    } catch {
      return;
    }
    const t = window.setInterval(() => setSnap({ ...acc.current }), 400);
    return () => { obs?.disconnect(); window.clearInterval(t); };
  }, []);

  return snap;
}

/**
 * Genuinely block the main thread. Not a simulation of jank — actual jank, so
 * the long-task numbers and the dropped-frame gap are real.
 */
export function useJankInjector(enabled: boolean, blockMs = 180, everyMs = 300) {
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => {
      const end = performance.now() + blockMs;
      // eslint-disable-next-line no-empty
      while (performance.now() < end) {}
    }, everyMs);
    return () => window.clearInterval(t);
  }, [enabled, blockMs, everyMs]);
}
