/** Liveness is a claim about FRAMES ADVANCING, not about connection state. */
export type Liveness = 'live' | 'degraded' | 'stale' | 'idle';

/** What the naive dashboard check reports — kept deliberately separate. */
export type NaiveState = 'connected' | 'error' | 'idle';

export interface TileStats {
  /** Frames our rVFC callback observed — used for inter-frame interval stats. */
  observedFrames: number;
  /**
   * Decoder truth from getVideoPlaybackQuality(). Deliberately NOT
   * `VideoFrameMetadata.presentedFrames`: that counts compositor presentations
   * and can exceed decoded frames, so differencing it against our own callback
   * count overstates "frames we missed". totalVideoFrames/droppedVideoFrames
   * are unambiguous, which is the only kind of number worth putting on screen.
   */
  totalFrames: number;
  droppedFrames: number;
  droppedPct: number | null;
  p50IntervalMs: number | null;
  p95IntervalMs: number | null;
  /** ms since the last observed frame, per the worker's independent clock. */
  staleMs: number;
  /** How far the media clock advanced vs wall clock. ~1.0 healthy, ~0 frozen. */
  mediaDriftRatio: number | null;
}

export interface TileReport {
  id: string;
  label: string;
  liveness: Liveness;
  naive: NaiveState;
  stats: TileStats;
}

/** Deliberately-induced failures. Every one is REAL, none are cosmetic. */
export type Fault =
  | 'none'
  /** hls.stopLoad() — buffer drains, then the element freezes with NO error event. */
  | 'freeze'
  /** Busy-loop the main thread — genuinely starves rVFC and spikes long tasks. */
  | 'jank'
  /** Cap to the lowest rendition — real bitrate/quality degradation. */
  | 'lowQuality';

// ── worker protocol ────────────────────────────────────────────────────────

export type ToWorker =
  | { type: 'register'; id: string; staleAfterMs: number; degradedAfterMs: number }
  | { type: 'unregister'; id: string }
  /** Heartbeat emitted from the main thread on each presented frame. */
  | { type: 'frame'; id: string; at: number; mediaTime: number }
  | { type: 'idle'; id: string };

export type FromWorker = {
  type: 'status';
  /** id → [liveness, staleMs, mediaDriftRatio|null] */
  entries: Array<[string, Liveness, number, number | null]>;
};
