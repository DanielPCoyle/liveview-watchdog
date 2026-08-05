import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import type { Fault, NaiveState, TileStats } from './types';

const MAX_INTERVALS = 300;

function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(1);
}

export interface UseTileArgs {
  id: string;
  src: string;
  fault: Fault;
  /**
   * Focused feeds get full quality; wall tiles get pinned to the lowest
   * rendition. This is the real reason a video wall has a focused view — the
   * operator only ever studies one feed, so the rest need not cost full
   * bitrate. Real VMS clients pull a dedicated low-res sub-stream for this.
   */
  focused?: boolean;
  /** Heartbeat sink — the worker owns the clock, we only report frames. */
  onFrame: (id: string, at: number, mediaTime: number) => void;
  onIdle: (id: string) => void;
}

export function useTile({ id, src, fault, focused = false, onFrame, onIdle }: UseTileArgs) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const intervalsRef = useRef<number[]>([]);
  const lastNowRef = useRef<number | null>(null);
  const observedRef = useRef(0);
  const rafHandleRef = useRef<number | null>(null);

  const [naive, setNaive] = useState<NaiveState>('idle');
  const [stats, setStats] = useState<Pick<TileStats, 'observedFrames' | 'totalFrames' | 'droppedFrames' | 'droppedPct' | 'p50IntervalMs' | 'p95IntervalMs'>>({
    observedFrames: 0, totalFrames: 0, droppedFrames: 0, droppedPct: null, p50IntervalMs: null, p95IntervalMs: null,
  });

  // ── attach the stream ────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let disposed = false;

    const refreshNaive = () => {
      // The check most dashboards actually ship: "is it connected?"
      // Deliberately NOT frame-aware — this is the control that lies.
      if (disposed) return;
      setNaive(v.error ? 'error' : v.readyState >= 2 && !v.paused ? 'connected' : 'idle');
    };

    if (Hls.isSupported()) {
      // Small forward buffer: what a genuinely live view runs for latency, and
      // it makes a stalled feed manifest in seconds rather than after a minute
      // of coasting on buffered segments.
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        maxBufferLength: 3,
        backBufferLength: 4,
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { void v.play().catch(() => {}); refreshNaive(); });
      hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) refreshNaive(); });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src;
      void v.play().catch(() => {});
    }

    const evts = ['playing', 'pause', 'waiting', 'error', 'stalled', 'canplay'] as const;
    evts.forEach((ev) => v.addEventListener(ev, refreshNaive));
    const naiveTimer = window.setInterval(refreshNaive, 500);

    // ── frame observation ──────────────────────────────────────────────────
    const onVideoFrame: VideoFrameRequestCallback = (now, meta) => {
      if (disposed) return;
      observedRef.current += 1;

      if (lastNowRef.current != null) {
        const dt = now - lastNowRef.current;
        const arr = intervalsRef.current;
        arr.push(dt);
        if (arr.length > MAX_INTERVALS) arr.shift();
      }
      lastNowRef.current = now;

      onFrame(id, performance.now(), meta.mediaTime);
      rafHandleRef.current = v.requestVideoFrameCallback(onVideoFrame);
    };

    if ('requestVideoFrameCallback' in v) {
      rafHandleRef.current = v.requestVideoFrameCallback(onVideoFrame);
    }

    const statsTimer = window.setInterval(() => {
      if (disposed) return;
      const sorted = [...intervalsRef.current].sort((a, b) => a - b);
      const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
      const total = q?.totalVideoFrames ?? 0;
      const dropped = q?.droppedVideoFrames ?? 0;
      setStats({
        observedFrames: observedRef.current,
        totalFrames: total,
        droppedFrames: dropped,
        droppedPct: total > 0 ? +((dropped / total) * 100).toFixed(1) : null,
        p50IntervalMs: percentile(sorted, 0.5),
        p95IntervalMs: percentile(sorted, 0.95),
      });
    }, 400);

    return () => {
      disposed = true;
      window.clearInterval(naiveTimer);
      window.clearInterval(statsTimer);
      evts.forEach((ev) => v.removeEventListener(ev, refreshNaive));
      if (rafHandleRef.current != null && 'cancelVideoFrameCallback' in v) {
        v.cancelVideoFrameCallback(rafHandleRef.current);
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
      onIdle(id);
    };
  }, [id, src, onFrame, onIdle]);

  // ── fault injection — all three are REAL, none cosmetic ──────────────────
  useEffect(() => {
    const hls = hlsRef.current;
    const v = videoRef.current;
    if (!v) return;

    if (fault === 'freeze') {
      // Stop fetching segments. The buffer drains, playback halts on the last
      // decoded frame, readyState stays high and NO error fires. This is the
      // failure that looks healthy.
      hls?.stopLoad();
    } else if (fault === 'lowQuality') {
      if (hls) hls.currentLevel = 0;
    } else {
      hls?.startLoad();
      // Quality follows selection (see `focused`). Note: the bundled ffmpeg
      // cameras emit a SINGLE rendition, so this policy is wired and correct
      // but has nothing to switch between — point it at a multi-variant source
      // to see it bite.
      if (hls) hls.currentLevel = focused ? -1 : 0;
    }
  }, [fault, focused]);

  const attachRef = useCallback((el: HTMLVideoElement | null) => { videoRef.current = el; }, []);

  return { attachRef, naive, stats };
}
