import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTile } from './useTile';
import { useLongTasks, useJankInjector } from './perf';
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
  label: `cam${i + 1}`,
  src: `/live/cam${i + 1}/index.m3u8`,
}));

const DEGRADED_AFTER_MS = 400;
const STALE_AFTER_MS = 1200;

interface WorkerStatus { liveness: Liveness; staleMs: number; drift: number | null }

function Tile(props: {
  id: string; label: string; src: string; fault: Fault;
  status: WorkerStatus | undefined;
  onFrame: (id: string, at: number, mediaTime: number) => void;
  onIdle: (id: string) => void;
  onFaultChange: (id: string, f: Fault) => void;
  showNaiveOnly: boolean;
}) {
  const { attachRef, naive, stats } = useTile({
    id: props.id, src: props.src, fault: props.fault, onFrame: props.onFrame, onIdle: props.onIdle,
  });
  const st = props.status;
  const liveness = st?.liveness ?? 'idle';

  return (
    <div className={`tile tile--${props.showNaiveOnly ? naive : liveness}`}>
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

      {!props.showNaiveOnly && (
        <dl className="tile__stats">
          <div><dt>interval p50/p95</dt><dd>{stats.p50IntervalMs ?? '–'} / {stats.p95IntervalMs ?? '–'} ms</dd></div>
          <div><dt>decoded</dt><dd>{stats.totalFrames}</dd></div>
          <div><dt>dropped</dt><dd className={(stats.droppedPct ?? 0) > 1 ? 'warn' : ''}>
            {stats.droppedFrames}{stats.droppedPct != null ? ` (${stats.droppedPct}%)` : ''}
          </dd></div>
          <div><dt>media drift</dt><dd className={st?.drift != null && st.drift < 0.5 ? 'bad' : ''}>{st?.drift == null ? '–' : st.drift.toFixed(2)}</dd></div>
        </dl>
      )}

      <div className="tile__faults">
        {(['none', 'freeze', 'lowQuality'] as Fault[]).map((f) => (
          <button
            key={f}
            className={props.fault === f ? 'on' : ''}
            onClick={() => props.onFaultChange(props.id, f)}
          >{f === 'none' ? 'healthy' : f === 'freeze' ? 'freeze' : 'low-q'}</button>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [tileCount, setTileCount] = useState(4);
  const [faults, setFaults] = useState<Record<string, Fault>>({});
  const [statuses, setStatuses] = useState<Record<string, WorkerStatus>>({});
  const [jank, setJank] = useState(false);
  const [showNaiveOnly, setShowNaiveOnly] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const perf = useLongTasks();
  useJankInjector(jank);

  const tiles = useMemo(
    () => Array.from({ length: tileCount }, (_, i) => {
      const s = SOURCES[i % SOURCES.length];
      return { id: `t${i}`, label: s.label, src: s.src };
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

  const onFrame = useCallback((id: string, at: number, mediaTime: number) => {
    workerRef.current?.postMessage({ type: 'frame', id, at, mediaTime } satisfies ToWorker);
  }, []);
  const onIdle = useCallback((id: string) => {
    workerRef.current?.postMessage({ type: 'idle', id } satisfies ToWorker);
  }, []);
  const onFaultChange = useCallback((id: string, f: Fault) => {
    setFaults((prev) => ({ ...prev, [id]: f }));
  }, []);

  const liveCount = tiles.filter((t) => statuses[t.id]?.liveness === 'live').length;
  const staleCount = tiles.filter((t) => statuses[t.id]?.liveness === 'stale').length;

  return (
    <div className="app">
      <header>
        <h1>Liveview Watchdog</h1>
        <p className="sub">
          A tile is only <em>live</em> if frames are advancing. Connection state is not liveness —
          freeze a tile below and watch the naive view stay green while the media clock stops.
        </p>
      </header>

      <section className="controls">
        <label>
          tiles
          <input type="range" min={1} max={24} value={tileCount}
            onChange={(e) => setTileCount(Number(e.target.value))} />
          <output>{tileCount}</output>
        </label>

        <button className={jank ? 'on' : ''} onClick={() => setJank((v) => !v)}>
          {jank ? 'stop main-thread jank' : 'inject main-thread jank'}
        </button>

        <button className={showNaiveOnly ? 'on' : ''} onClick={() => setShowNaiveOnly((v) => !v)}>
          {showNaiveOnly ? 'showing: naive check' : 'showing: frame-aware watchdog'}
        </button>
      </section>

      <section className="hud">
        <div><span>live</span><strong className="ok">{liveCount}</strong></div>
        <div><span>stale</span><strong className={staleCount ? 'bad' : ''}>{staleCount}</strong></div>
        <div><span>long tasks</span><strong className={perf.longTasks ? 'warn' : ''}>{perf.longTasks}</strong></div>
        <div><span>longest task</span><strong>{perf.longestTaskMs.toFixed(0)} ms</strong></div>
        <div><span>blocking time</span><strong>{(perf.blockedMs / 1000).toFixed(1)} s</strong></div>
      </section>

      <main className="grid">
        {tiles.map((t) => (
          <Tile
            key={t.id} id={t.id} label={t.label} src={t.src}
            fault={faults[t.id] ?? 'none'}
            status={statuses[t.id]}
            onFrame={onFrame} onIdle={onIdle} onFaultChange={onFaultChange}
            showNaiveOnly={showNaiveOnly}
          />
        ))}
      </main>

      <footer>
        <p>
          The watchdog runs in a Worker with its own clock. That matters: a main-thread liveness
          check is a victim of the jank it is meant to detect — while the thread is blocked, its
          timer doesn&rsquo;t fire either, and silence reads as health.
        </p>
      </footer>
    </div>
  );
}
