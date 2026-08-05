import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTile } from './useTile';
import { useLongTasks, useJankInjector } from './perf';
import { VideoWall, type WallStreamRef } from './VideoWall';
import type { Fault, FromWorker, Liveness, ToWorker } from './types';

/**
 * Local live-HLS cameras from `scripts/cameras.sh` — genuinely live: sliding
 * playlist window, 1s segments, no EXT-X-ENDLIST.
 *
 * Public "test streams" are VOD. hls.js buffers a VOD asset end-to-end, so it
 * can't be starved and none of the live-edge behaviour this project measures
 * ever happens. Using them here would have been a demo of the wrong thing.
 */
const CAMERA_COUNT = 4;
const SOURCES = Array.from({ length: CAMERA_COUNT }, (_, i) => ({
  label: `CAM ${i + 1}`,
  src: `/live/cam${i + 1}/index.m3u8`,
}));

const DEGRADED_AFTER_MS = 400;
const STALE_AFTER_MS = 1200;

interface WorkerStatus { liveness: Liveness; staleMs: number; drift: number | null }
type Mode = 'dom' | 'webgl';

interface Incident { at: string; cam: string; text: string; kind: 'lost' | 'restored' }

// ── DOM presentation: one <video> element per tile ─────────────────────────
function Tile(props: {
  id: string; label: string; src: string; fault: Fault;
  status: WorkerStatus | undefined;
  onFrame: (id: string, at: number, mediaTime: number) => void;
  onIdle: (id: string) => void;
  onFaultChange: (id: string, f: Fault) => void;
  showNaiveOnly: boolean;
  focused?: boolean;
  variant?: 'grid' | 'hero' | 'strip';
  onSelect?: (id: string) => void;
}) {
  const { attachRef, naive, stats } = useTile({
    id: props.id, src: props.src, fault: props.fault, focused: props.focused,
    onFrame: props.onFrame, onIdle: props.onIdle,
  });
  const st = props.status;
  const liveness = st?.liveness ?? 'idle';
  const variant = props.variant ?? 'grid';

  return (
    <div
      className={`tile tile--${variant} tile--${props.showNaiveOnly ? naive : liveness}`}
      onClick={variant === 'hero' ? undefined : () => props.onSelect?.(props.id)}
      role={variant === 'hero' ? undefined : 'button'}
      tabIndex={variant === 'hero' ? undefined : 0}
      onKeyDown={variant === 'hero' ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelect?.(props.id); } }}
      title={variant === 'hero' ? undefined : 'Open this feed'}
    >
      <video ref={attachRef} muted playsInline />
      <div className="tile__bar">
        <span className="tile__label">{props.label}</span>
        {props.showNaiveOnly ? (
          <span className={`pill pill--${naive}`}>{naive}</span>
        ) : (
          <span className={`pill pill--${liveness}`}>
            {liveness}
            {liveness !== 'idle' && liveness !== 'live' ? ` ${(st!.staleMs / 1000).toFixed(1)}s` : ''}
          </span>
        )}
      </div>

      {!props.showNaiveOnly && variant !== 'strip' && (
        <dl className="tile__stats">
          <div><dt>interval p50/p95</dt><dd>{stats.p50IntervalMs ?? '–'} / {stats.p95IntervalMs ?? '–'} ms</dd></div>
          <div><dt>decoded</dt><dd>{stats.totalFrames}</dd></div>
          <div><dt>dropped</dt><dd className={(stats.droppedPct ?? 0) > 1 ? 'warn' : ''}>
            {stats.droppedFrames}{stats.droppedPct != null ? ` (${stats.droppedPct}%)` : ''}
          </dd></div>
          <div><dt>media drift</dt><dd className={st?.drift != null && st.drift < 0.5 ? 'bad' : ''}>{st?.drift == null ? '–' : st.drift.toFixed(2)}</dd></div>
        </dl>
      )}

      {variant !== 'strip' && (
        <div className="tile__faults">
          {(['none', 'freeze', 'lowQuality'] as Fault[]).map((f) => (
            <button key={f} className={props.fault === f ? 'on' : ''}
              onClick={(e) => { e.stopPropagation(); props.onFaultChange(props.id, f); }}>
              {f === 'none' ? 'healthy' : f === 'freeze' ? 'freeze' : 'low-q'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── WebGL presentation: video decodes offscreen, GPU composites the wall ───
function WallStream(props: {
  id: string; src: string; fault: Fault; focused?: boolean;
  onFrame: (id: string, at: number, mediaTime: number) => void;
  onIdle: (id: string) => void;
  onEl: (id: string, el: HTMLVideoElement | null) => void;
}) {
  const { attachRef } = useTile({
    id: props.id, src: props.src, fault: props.fault, focused: props.focused,
    onFrame: props.onFrame, onIdle: props.onIdle,
  });
  const { onEl, id } = props;
  const ref = useCallback((el: HTMLVideoElement | null) => { attachRef(el); onEl(id, el); }, [attachRef, onEl, id]);
  // Kept in the document (not display:none) so decoding continues.
  return <video ref={ref} muted playsInline />;
}

export default function App() {
  const [tileCount, setTileCount] = useState(4);
  const [faults, setFaults] = useState<Record<string, Fault>>({});
  const [statuses, setStatuses] = useState<Record<string, WorkerStatus>>({});
  const [jank, setJank] = useState(false);
  const [showNaiveOnly, setShowNaiveOnly] = useState(false);
  const [mode, setMode] = useState<Mode>('dom');
  const [wallFps, setWallFps] = useState(0);
  const [elVersion, setElVersion] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [clock, setClock] = useState(() => new Date().toLocaleTimeString());

  const workerRef = useRef<Worker | null>(null);
  const elsRef = useRef<Record<string, HTMLVideoElement | null>>({});
  const prevLiveness = useRef<Record<string, Liveness>>({});
  const perf = useLongTasks();
  useJankInjector(jank);

  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date().toLocaleTimeString()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const tiles = useMemo(
    () => Array.from({ length: tileCount }, (_, i) => {
      const s = SOURCES[i % SOURCES.length];
      return { id: `t${i}`, label: tileCount > SOURCES.length ? `${s.label}·${Math.floor(i / SOURCES.length) + 1}` : s.label, src: s.src };
    }),
    [tileCount],
  );

  useEffect(() => {
    const w = new Worker(new URL('./watchdog.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.type !== 'status') return;
      setStatuses((prev) => {
        const next = { ...prev };
        for (const [id, liveness, staleMs, drift] of e.data.entries) next[id] = { liveness, staleMs, drift };
        return next;
      });
    };
    return () => { w.terminate(); workerRef.current = null; };
  }, []);

  useEffect(() => {
    const w = workerRef.current;
    if (!w) return;
    for (const t of tiles) {
      w.postMessage({ type: 'register', id: t.id, staleAfterMs: STALE_AFTER_MS, degradedAfterMs: DEGRADED_AFTER_MS } satisfies ToWorker);
    }
  }, [tiles]);

  // Incident log — transitions in and out of stale, timestamped. The record an
  // operator would actually be asked for afterwards.
  useEffect(() => {
    const add: Incident[] = [];
    for (const t of tiles) {
      const now = statuses[t.id]?.liveness;
      if (!now) continue;
      const was = prevLiveness.current[t.id];
      if (was && was !== now) {
        if (now === 'stale') add.push({ at: new Date().toLocaleTimeString(), cam: t.label, text: 'signal lost — frames stopped arriving', kind: 'lost' });
        else if (was === 'stale') add.push({ at: new Date().toLocaleTimeString(), cam: t.label, text: 'signal restored', kind: 'restored' });
      }
      prevLiveness.current[t.id] = now;
    }
    if (add.length) setIncidents((prev) => [...add, ...prev].slice(0, 40));
  }, [statuses, tiles]);

  const onFrame = useCallback((id: string, at: number, mediaTime: number) => {
    workerRef.current?.postMessage({ type: 'frame', id, at, mediaTime } satisfies ToWorker);
  }, []);
  const onIdle = useCallback((id: string) => {
    workerRef.current?.postMessage({ type: 'idle', id } satisfies ToWorker);
  }, []);
  const onFaultChange = useCallback((id: string, f: Fault) => {
    setFaults((prev) => ({ ...prev, [id]: f }));
  }, []);
  // Video elements arrive via ref callbacks AFTER mount. A ref mutation can't
  // tell React anything, so bump a version to recompute the stream list once
  // the elements actually exist — otherwise the wall builds against nulls and
  // renders black tiles.
  const onEl = useCallback((id: string, el: HTMLVideoElement | null) => {
    if (elsRef.current[id] === el) return;
    elsRef.current[id] = el;
    setElVersion((v) => v + 1);
  }, []);
  const onFps = useCallback((f: number) => setWallFps(f), []);
  const onFocus = useCallback((id: string | null) => setFocusedId(id), []);

  // Escape always returns to the grid — an operator shouldn't have to find a
  // close button to get their whole wall back.
  useEffect(() => {
    if (!focusedId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocusedId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedId]);

  // A feed that vanishes (wall resized smaller) must not stay focused.
  useEffect(() => {
    if (focusedId && !tiles.some((t) => t.id === focusedId)) setFocusedId(null);
  }, [tiles, focusedId]);

  const wallStreams: WallStreamRef[] = useMemo(
    () => tiles.map((t) => ({ id: t.id, el: elsRef.current[t.id] ?? null })),
    // elVersion is the signal that refs changed; tiles covers set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tiles, elVersion],
  );

  // Plain id → liveness map, so status ticks never invalidate wall layout.
  const statusById = useMemo(() => {
    const m: Record<string, Liveness> = {};
    for (const t of tiles) m[t.id] = statuses[t.id]?.liveness ?? 'idle';
    return m;
  }, [tiles, statuses]);

  const liveCount = tiles.filter((t) => statuses[t.id]?.liveness === 'live').length;
  const staleCount = tiles.filter((t) => statuses[t.id]?.liveness === 'stale').length;

  return (
    <div className="app">
      <header className="bar">
        <div className="bar__id">
          <span className="bar__dot" aria-hidden />
          <h1>Liveview Watchdog</h1>
          <span className="bar__sub">frame-advancement monitoring</span>
        </div>
        <div className="bar__clock">{clock}</div>
      </header>

      <section className="strip">
        <div><span>feeds</span><strong>{tiles.length}</strong></div>
        <div><span>live</span><strong className="ok">{liveCount}</strong></div>
        <div><span>signal lost</span><strong className={staleCount ? 'bad' : ''}>{staleCount}</strong></div>
        <div><span>compositor</span><strong>{mode === 'webgl' ? 'GPU' : 'DOM'}</strong></div>
        <div><span>wall fps</span><strong>{mode === 'webgl' ? wallFps.toFixed(0) : '–'}</strong></div>
        <div><span>long tasks</span><strong className={perf.longTasks ? 'warn' : ''}>{perf.longTasks}</strong></div>
        <div><span>blocking</span><strong>{(perf.blockedMs / 1000).toFixed(1)}s</strong></div>
      </section>

      <section className="controls">
        <label>
          feeds
          <input type="range" min={1} max={64} value={tileCount} onChange={(e) => setTileCount(Number(e.target.value))} />
          <output>{tileCount}</output>
        </label>
        <button className={mode === 'webgl' ? 'on' : ''} onClick={() => setMode((m) => (m === 'dom' ? 'webgl' : 'dom'))}>
          compositor: {mode === 'webgl' ? 'GPU (three.js)' : 'DOM <video>'}
        </button>
        <button className={jank ? 'on' : ''} onClick={() => setJank((v) => !v)}>
          {jank ? 'stop main-thread jank' : 'inject main-thread jank'}
        </button>
        {mode === 'dom' && (
          <button className={showNaiveOnly ? 'on' : ''} onClick={() => setShowNaiveOnly((v) => !v)}>
            {showNaiveOnly ? 'showing: naive "is it connected?"' : 'showing: frame-aware watchdog'}
          </button>
        )}
      </section>

      <div className="stage">
        {mode === 'dom' ? (
          focusedId ? (
            <main className="focus">
              <div className="focus__hero">
                {tiles.filter((t) => t.id === focusedId).map((t) => (
                  <Tile key={t.id} id={t.id} label={t.label} src={t.src} variant="hero" focused
                    fault={faults[t.id] ?? 'none'} status={statuses[t.id]}
                    onFrame={onFrame} onIdle={onIdle} onFaultChange={onFaultChange}
                    showNaiveOnly={showNaiveOnly} />
                ))}
                <button className="focus__close" onClick={() => setFocusedId(null)} aria-label="Back to grid (Esc)">✕</button>
              </div>
              <div className="focus__strip">
                {tiles.filter((t) => t.id !== focusedId).map((t) => (
                  <Tile key={t.id} id={t.id} label={t.label} src={t.src} variant="strip"
                    fault={faults[t.id] ?? 'none'} status={statuses[t.id]}
                    onFrame={onFrame} onIdle={onIdle} onFaultChange={onFaultChange}
                    showNaiveOnly={showNaiveOnly} onSelect={setFocusedId} />
                ))}
              </div>
            </main>
          ) : (
            <main className="grid">
              {tiles.map((t) => (
                <Tile key={t.id} id={t.id} label={t.label} src={t.src} variant="grid"
                  fault={faults[t.id] ?? 'none'} status={statuses[t.id]}
                  onFrame={onFrame} onIdle={onIdle} onFaultChange={onFaultChange}
                  showNaiveOnly={showNaiveOnly} onSelect={setFocusedId} />
              ))}
            </main>
          )
        ) : (
          <div className="wall-host">
            <div className="decode-pool" aria-hidden>
              {tiles.map((t) => (
                <WallStream key={t.id} id={t.id} src={t.src} fault={faults[t.id] ?? 'none'}
                  focused={focusedId === t.id}
                  onFrame={onFrame} onIdle={onIdle} onEl={onEl} />
              ))}
            </div>
            <VideoWall streams={wallStreams} statusById={statusById}
              focusedId={focusedId} onFocus={onFocus} onFps={onFps} />
            {focusedId && (
              <button className="focus__close focus__close--wall" onClick={() => setFocusedId(null)} aria-label="Back to grid (Esc)">✕</button>
            )}
          </div>
        )}

        <aside className="log">
          <h2>Incidents</h2>
          {incidents.length === 0 ? (
            <p className="log__empty">No signal loss recorded.</p>
          ) : (
            <ul>
              {incidents.map((i, n) => (
                <li key={n} className={i.kind}>
                  <time>{i.at}</time>
                  <span className="log__cam">{i.cam}</span>
                  <span>{i.text}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="log__note">
            Use <code>scripts/cameras.sh freeze N</code> to stop a camera at the encoder.
          </p>
        </aside>
      </div>
    </div>
  );
}
