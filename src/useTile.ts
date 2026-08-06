import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { captureError } from './telemetry';
import type { Fault, NaiveState, TileStats } from './types';

const MAX_INTERVALS = 300;

/** Floor for forward buffer, in seconds — see the LEVEL_LOADED handler. */
const MIN_BUFFER_S = 3;

/** Recovery attempts per error class before a feed is left dead and reported. */
const MAX_RECOVERIES = 3;

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
  /** Audio is opt-in per feed; everything starts muted so autoplay works. */
  audible?: boolean;
  /** Heartbeat sink — the worker owns the clock, we only report frames. */
  onFrame: (id: string, at: number, mediaTime: number) => void;
  onIdle: (id: string) => void;
}

export function useTile({ id, src, fault, focused = false, audible = false, onFrame, onIdle }: UseTileArgs) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  /** The ERROR handler is bound once at attach; the fault changes under it. */
  const faultRef = useRef<Fault>(fault);
  const intervalsRef = useRef<number[]>([]);
  const lastNowRef = useRef<number | null>(null);
  const observedRef = useRef(0);

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

    /**
     * Synthetic feed for `mock:` sources — see `mockMode()` in feeds.ts.
     *
     * A canvas `captureStream` gives the element a real MediaStream, so the
     * wall and the row thumbnails draw an actual moving picture, and the frame
     * heartbeat is emitted on the same channel a real decoder uses. Everything
     * downstream — worker clock, hysteresis, auto-promote, incidents — is
     * therefore exercised for real; only the HLS transport is replaced.
     *
     * `freeze` stops emitting frames, which is exactly what a starved buffer
     * does, so the fault behaves the same way it does against a live feed.
     */
    if (src.startsWith('mock:')) {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d');
      v.srcObject = canvas.captureStream(15);
      void v.play().catch(() => {});
      let media = 0;
      let last = Date.now();
      let delivered = 0;
      const tick = window.setInterval(() => {
        if (disposed) return;
        const now = Date.now();
        const dt = now - last;
        last = now;

        /**
         * Freezing does NOT stop the heartbeat, and that is the whole point.
         *
         * A feed whose frames stop arriving is the easy case — any arrival-based
         * check catches it, and it is barely distinguishable from signal loss.
         * The failure this project exists for is the other one: frames keep
         * arriving, the element stays `readyState 4` and unpaused, the naive
         * check keeps reporting "connected" — and the media clock has stopped,
         * so what is on screen is not now.
         *
         * So a frozen mock keeps delivering frames at full rate and keeps
         * reporting the SAME media time. Windowed drift collapses to 0 and the
         * watchdog calls it stale on the evidence that actually matters, while
         * every other indicator still looks healthy.
         */
        const frozen = faultRef.current === 'freeze';
        // The media clock is derived from ELAPSED TIME, not from a tick count.
        // Counting ticks assumes the timer actually fires at its nominal rate;
        // when it doesn't, media falls behind wall clock and every feed looks
        // stale for a reason that is purely an artefact of the mock.
        if (!frozen) media += dt / 1000;
        delivered += 1;

        if (ctx) {
          ctx.fillStyle = '#0d1520'; ctx.fillRect(0, 0, 320, 180);
          ctx.fillStyle = '#4fa37c'; ctx.font = '16px monospace';
          ctx.fillText(`${src} ${media.toFixed(1)}s`, 16, 96);
        }

        observedRef.current += 1;
        onFrame(id, now, media);
      }, 66);

      // Stats on the same 400ms cadence the real path uses. Pushing them from
      // the frame loop meant a React render per tile per frame — 45 a second on
      // three feeds, which starved the very interval being measured.
      const mockStats = window.setInterval(() => {
        if (disposed) return;
        setNaive('connected');
        setStats((s) => ({
          ...s, observedFrames: delivered, totalFrames: delivered,
          droppedFrames: 0, droppedPct: 0, p50IntervalMs: 66,
        }));
      }, 400);

      return () => {
        disposed = true;
        window.clearInterval(tick);
        window.clearInterval(mockStats);
        v.srcObject = null;
        onIdle(id);
      };
    }

    if (Hls.isSupported()) {
      // Small forward buffer: what a genuinely live view runs for latency, and
      // it makes a stalled feed manifest in seconds rather than after a minute
      // of coasting on buffered segments.
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        maxBufferLength: MIN_BUFFER_S,
        backBufferLength: 4,
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { void v.play().catch(() => {}); refreshNaive(); });

      /**
       * Buffer headroom has to be relative to SEGMENT SIZE, not absolute.
       *
       * 3 seconds is three segments of headroom on a 1-second feed and less
       * than ONE segment on a public traffic camera publishing 10-second
       * segments — which parks the player permanently at the live edge, so any
       * jitter in when the encoder publishes drains the buffer and playback
       * stalls. That stall is real (frames genuinely stop) and the watchdog is
       * right to report it, but the cause is this config, not the camera, and
       * an incident log full of self-inflicted outages is worse than useless.
       *
       * Keep the aggressive target as a FLOOR and ask for two segments.
       */
      hls.on(Hls.Events.LEVEL_LOADED, (_e, d) => {
        const want = Math.max(MIN_BUFFER_S, (d.details.targetduration || 0) * 2);
        if (hls.config.maxBufferLength !== want) hls.config.maxBufferLength = want;
      });
      /**
       * Fatal errors follow hls.js's own recovery ladder — reload on a network
       * error, flush and recover on a media error — but bounded, so a genuinely
       * dead origin does not become an infinite retry loop chewing the main
       * thread it is supposed to be measuring.
       *
       * Two things this deliberately does NOT do.
       *
       * It does not recover a feed the operator froze. `freeze` IS a
       * `stopLoad()`, and that surfaces as a fatal network error seconds later;
       * calling `startLoad()` on it would silently undo the injected fault and
       * make the demo lie about what it just did.
       *
       * It does not touch the watchdog. Recovery is an attempt, not an outcome —
       * the tile stays stale until frames actually advance again, because that
       * is the only evidence worth anything here. A feed that reconnects and
       * then delivers nothing is precisely the failure this project exists for.
       */
      let netRetries = 0;
      let mediaRetries = 0;
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        refreshNaive();
        if (faultRef.current === 'freeze') return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries < MAX_RECOVERIES) {
          netRetries += 1;
          hls.startLoad();
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < MAX_RECOVERIES) {
          mediaRetries += 1;
          hls.recoverMediaError();
        } else {
          captureError(new Error(`hls fatal: ${d.type} / ${d.details}`), {
            feed: id, src, netRetries, mediaRetries,
          });
        }
      });
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
    //
    // Deliberately NOT requestVideoFrameCallback. rVFC fires on frame
    // PRESENTATION, and these decoders are offscreen — the wall is drawn from
    // their textures, not from the elements themselves — so rVFC never fires
    // and every feed would look dead. (Observed: all four feeds reporting
    // "stale" while decoding normally.)
    //
    // getVideoPlaybackQuality().totalVideoFrames counts DECODED frames and is
    // unaffected by whether anything is presented. Poll it, and treat an
    // increase as evidence frames are arriving. That costs exact per-frame
    // timestamps — so the stat below is decode rate, not presentation interval,
    // and is labelled as such.
    let lastTotal = -1;
    const poll = () => {
      if (disposed) return;
      const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
      const total = q?.totalVideoFrames ?? 0;
      if (lastTotal >= 0 && total > lastTotal) {
        // Date.now(), not performance.now(): this timestamp is compared inside
        // a Worker, and a Worker has its OWN performance time origin. Comparing
        // across the boundary silently offsets every staleness reading by a
        // constant (it surfaced as a negative "stale for -2.6s"). Wall clock is
        // lower resolution but is the same clock on both sides.
        const now = Date.now();
        observedRef.current += total - lastTotal;
        if (lastNowRef.current != null) {
          const perFrame = (now - lastNowRef.current) / (total - lastTotal);
          const arr = intervalsRef.current;
          arr.push(perFrame);
          if (arr.length > MAX_INTERVALS) arr.shift();
        }
        lastNowRef.current = now;
        onFrame(id, now, v.currentTime);
      }
      lastTotal = total;
    };
    const pollTimer = window.setInterval(poll, 100);

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
      window.clearInterval(pollTimer);
      evts.forEach((ev) => v.removeEventListener(ev, refreshNaive));
      hlsRef.current?.destroy();
      hlsRef.current = null;
      onIdle(id);
    };
  }, [id, src, onFrame, onIdle]);

  // ── fault injection — all three are REAL, none cosmetic ──────────────────
  useEffect(() => {
    faultRef.current = fault;
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

  // Autoplay requires muted, so every feed starts muted and audio is opt-in.
  // Unmuting is driven by a click, which satisfies the gesture requirement.
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.muted = !audible;
  }, [audible]);

  const attachRef = useCallback((el: HTMLVideoElement | null) => { videoRef.current = el; }, []);

  return { attachRef, naive, stats };
}
