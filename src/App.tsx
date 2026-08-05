import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTile } from './useTile';
import { useLongTasks, useJankInjector } from './perf';
import { VideoWall, computeLayout, VW, VH, type Box, type WallStreamRef } from './VideoWall';
import type { Fault, FromWorker, Liveness, ToWorker } from './types';
import {
  loadRegistry, saveRegistry, probeFeed,
  DEFAULT_REGISTRY, type Registry, type ProbeResult,
} from './feeds';

/**
 * Local live-HLS cameras from `scripts/cameras.sh` — genuinely live: sliding
 * playlist window, 1s segments, no EXT-X-ENDLIST.
 *
 * Public "test streams" are VOD. hls.js buffers a VOD asset end-to-end, so it
 * can't be starved and none of the live-edge behaviour this project measures
 * ever happens. Using them here would have been a demo of the wrong thing.
 */
const DEGRADED_AFTER_MS = 400;
const STALE_AFTER_MS = 1200;

/**
 * How long a recovered feed stays promoted after its signal returns. Snapping
 * it back the instant frames resume is worse than not promoting it: the tile
 * vanishes with no explanation. Hold it, say "signal restored", then shrink.
 */
const RESOLVE_HOLD_MS = 4000;

interface WorkerStatus { liveness: Liveness; staleMs: number; drift: number | null }
interface Incident { at: string; cam: string; text: string; kind: 'lost' | 'restored' }

/**
 * An escalation is a snapshot, not a message. The evidence is captured at the
 * moment of reporting — liveness, how long it has been stale, media drift,
 * decode and drop counts — so the person receiving it gets numbers rather than
 * "camera 3 looks funny". That is the difference between a ticket someone can
 * action and one that starts with a round of questions.
 */
interface Escalation {
  id: string;
  at: string;
  cam: string;
  severity: 'low' | 'medium' | 'high';
  note: string;
  evidence: {
    liveness: Liveness; staleMs: number; drift: number | null;
    decoded: number; dropped: number; droppedPct: number | null;
    source: string;
  };
}

function pct(b: Box) {
  return {
    left: `${((b.x - b.w / 2) / VW) * 100}%`,
    top: `${((VH - (b.y + b.h / 2)) / VH) * 100}%`,
    width: `${(b.w / VW) * 100}%`,
    height: `${(b.h / VH) * 100}%`,
  };
}

/**
 * One stream: decodes into an offscreen <video> (portalled into the decode
 * pool) and renders its own chrome as a DOM overlay positioned over the WebGL
 * canvas. WebGL draws the picture; DOM draws the HUD. Keeping the stats in the
 * component that owns the decoder avoids pushing a 400ms-cadence stats stream
 * for every tile up into app state.
 */
function Stream(props: {
  id: string; label: string; src: string; fault: Fault;
  box: Box | undefined; isHero: boolean; resolved: boolean;
  status: WorkerStatus | undefined; showNaive: boolean; audible: boolean;
  onToggleAudio: (id: string) => void;
  onFrame: (id: string, at: number, mediaTime: number) => void;
  onIdle: (id: string) => void;
  onEl: (id: string, el: HTMLVideoElement | null) => void;
  onFaultChange: (id: string, f: Fault) => void;
  onToggleFocus: (id: string) => void;
  onReport: (id: string, cam: string, ev: Escalation['evidence']) => void;
  faultable: boolean;
}) {
  const { attachRef, naive, stats } = useTile({
    id: props.id, src: props.src, fault: props.fault, focused: props.isHero,
    audible: props.audible, onFrame: props.onFrame, onIdle: props.onIdle,
  });
  const { onEl, id } = props;
  const videoRef = useCallback((el: HTMLVideoElement | null) => { attachRef(el); onEl(id, el); }, [attachRef, onEl, id]);

  const st = props.status;
  const liveness = st?.liveness ?? 'idle';
  const shown = props.showNaive ? naive : liveness;

  return (
    <>
      {/* The decoder. Hidden by CSS rather than portalled elsewhere: moving an
          element between parents remounts it, which tears down the hls.js
          attachment and leaves a dead readyState-0 element behind. */}
      <video className="decoder" ref={videoRef} muted playsInline />
      {props.box && (
        <div className={`ov ov--${shown} ${props.isHero ? 'ov--hero' : ''}`} style={pct(props.box)}
          onClick={() => props.onToggleFocus(props.id)}
          role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onToggleFocus(props.id); } }}
          title={props.isHero ? 'Return this feed to the wall' : 'Open this feed'}
        >
          {props.resolved && <div className="toast">Signal restored</div>}
          <div className="ov__bar">
            <button className={`ov__audio ${props.audible ? 'on' : ''}`}
              title={props.audible ? 'Mute this feed' : 'Unmute this feed'}
              aria-label={props.audible ? `Mute ${props.label}` : `Unmute ${props.label}`}
              onClick={(e) => { e.stopPropagation(); props.onToggleAudio(props.id); }}>
              {props.audible ? '🔊' : '🔇'}
            </button>
            <span className="ov__label">{props.label}</span>
            <span className={`pill pill--${shown}`}>
              {shown}
              {!props.showNaive && liveness !== 'idle' && liveness !== 'live' ? ` ${(st!.staleMs / 1000).toFixed(1)}s` : ''}
            </span>
          </div>

          {props.isHero && !props.showNaive && (
            <dl className="ov__stats">
              <div><dt>decode interval</dt><dd>{stats.p50IntervalMs ?? '–'} ms</dd></div>
              <div><dt>decoded</dt><dd>{stats.totalFrames}</dd></div>
              <div><dt>dropped</dt><dd className={(stats.droppedPct ?? 0) > 1 ? 'warn' : ''}>
                {stats.droppedFrames}{stats.droppedPct != null ? ` (${stats.droppedPct}%)` : ''}
              </dd></div>
              <div><dt>media drift</dt><dd className={st?.drift != null && st.drift < 0.35 ? 'bad' : ''}>{st?.drift == null ? '–' : st.drift.toFixed(2)}</dd></div>
            </dl>
          )}

          {props.isHero && (
            <div className="ov__faults">
              {(['none', 'freeze', 'lowQuality'] as Fault[]).map((f) => (
                <button key={f} className={props.fault === f ? 'on' : ''}
                  onClick={(e) => { e.stopPropagation(); props.onFaultChange(props.id, f); }}>
                  {f === 'none' ? 'healthy' : f === 'freeze' ? 'freeze' : 'low-q'}
                </button>
              ))}
              <button className="ov__report"
                onClick={(e) => {
                  e.stopPropagation();
                  // Snapshot the evidence at the moment of reporting, from the
                  // component that actually owns the decoder.
                  props.onReport(props.id, props.label, {
                    liveness, staleMs: st?.staleMs ?? 0, drift: st?.drift ?? null,
                    decoded: stats.totalFrames, dropped: stats.droppedFrames,
                    droppedPct: stats.droppedPct, source: props.src,
                  });
                }}>report incident</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ReportDialog(props: {
  pending: { id: string; cam: string; evidence: Escalation['evidence'] };
  onSubmit: (severity: Escalation['severity'], note: string) => void;
  onCancel: () => void;
}) {
  const [severity, setSeverity] = useState<Escalation['severity']>('medium');
  const [note, setNote] = useState('');
  const ev = props.pending.evidence;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Report incident"
      onClick={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <form className="modal__panel" onSubmit={(e) => { e.preventDefault(); props.onSubmit(severity, note); }}>
        <h2>Escalate — {props.pending.cam}</h2>

        <label className="field">
          <span>Severity</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Escalation['severity'])}>
            <option value="low">Low — note for review</option>
            <option value="medium">Medium — needs attention</option>
            <option value="high">High — acting on this now</option>
          </select>
        </label>

        <label className="field">
          <span>What did you see?</span>
          <textarea rows={3} value={note} autoFocus
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional. The measurements below are attached automatically." />
        </label>

        {/* Attached automatically — the point of the feature. */}
        <div className="field">
          <span>Attached evidence</span>
          <dl className="evidence">
            <div><dt>liveness</dt><dd className={ev.liveness === 'stale' ? 'bad' : ''}>{ev.liveness}</dd></div>
            <div><dt>stale for</dt><dd>{(ev.staleMs / 1000).toFixed(1)}s</dd></div>
            <div><dt>media drift</dt><dd className={ev.drift != null && ev.drift < 0.35 ? 'bad' : ''}>{ev.drift == null ? '–' : ev.drift.toFixed(2)}</dd></div>
            <div><dt>decoded</dt><dd>{ev.decoded}</dd></div>
            <div><dt>dropped</dt><dd>{ev.dropped}{ev.droppedPct != null ? ` (${ev.droppedPct}%)` : ''}</dd></div>
            <div className="evidence__src"><dt>source</dt><dd>{ev.source}</dd></div>
          </dl>
        </div>

        <div className="modal__actions">
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="submit" className="on">Submit escalation</button>
        </div>
      </form>
    </div>
  );
}


/**
 * Feed registry panel. Register a stream, assign it to a group, and — before it
 * ever reaches the wall — probe it. The probe is the useful part: a URL cannot
 * tell you whether it is live or VOD, or whether its SEGMENTS are CORS-enabled
 * as well as its playlist, and both mistakes fail in confusing ways later.
 */
function FeedPanel(props: {
  registry: Registry;
  activeGroup: string;
  onChange: (r: Registry) => void;
  onClose: () => void;
}) {
  const { registry } = props;
  const [label, setLabel] = useState('');
  const [src, setSrc] = useState('');
  const [groupId, setGroupId] = useState(props.activeGroup || registry.groups[0]?.id || '');
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [newGroup, setNewGroup] = useState('');

  const runProbe = async () => {
    if (!src.trim()) return;
    setProbing(true); setProbe(null);
    setProbe(await probeFeed(src.trim()));
    setProbing(false);
  };

  const add = (force = false) => {
    const url = src.trim();
    if (!url || !groupId) return;
    if (!force && (!probe || !probe.ok)) return;
    props.onChange({
      ...registry,
      feeds: [...registry.feeds, {
        id: `f-${Date.now().toString(36)}`,
        label: label.trim() || `FEED ${registry.feeds.length + 1}`,
        src: url, groupId,
      }],
    });
    setLabel(''); setSrc(''); setProbe(null);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Feed registry"
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal__panel panel">
        <h2>Feed registry</h2>

        <div className="field">
          <span>Register a feed</span>
          <div className="panel__add">
            <input placeholder="Label (e.g. LOBBY-01)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <input placeholder="HLS URL (.m3u8)" value={src}
              onChange={(e) => { setSrc(e.target.value); setProbe(null); }} />
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {registry.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <button type="button" onClick={runProbe} disabled={!src.trim() || probing}>
              {probing ? 'checking…' : 'check'}
            </button>
            <button type="button" className="on" onClick={() => add()} disabled={!probe?.ok}>add</button>
          </div>
          {probe && (
            <p className={`probe probe--${probe.ok ? 'ok' : 'bad'}`}>
              <strong>{probe.verdict}</strong> — {probe.detail}
              {!probe.ok && (
                <button type="button" className="probe__force" onClick={() => add(true)}>add anyway</button>
              )}
            </p>
          )}
        </div>

        <div className="field">
          <span>Groups</span>
          <ul className="panel__groups">
            {registry.groups.map((g) => (
              <li key={g.id}>
                <span>{g.name}</span>
                <span className="panel__count">{registry.feeds.filter((f) => f.groupId === g.id).length}</span>
                <button type="button" disabled={registry.groups.length <= 1}
                  title={registry.groups.length <= 1 ? 'Keep at least one group' : 'Remove group and its feeds'}
                  onClick={() => props.onChange({
                    groups: registry.groups.filter((x) => x.id !== g.id),
                    feeds: registry.feeds.filter((f) => f.groupId !== g.id),
                  })}>remove</button>
              </li>
            ))}
          </ul>
          <div className="panel__add">
            <input placeholder="New group name" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
            <button type="button" disabled={!newGroup.trim()} onClick={() => {
              props.onChange({ ...registry, groups: [...registry.groups, { id: `g-${Date.now().toString(36)}`, name: newGroup.trim() }] });
              setNewGroup('');
            }}>add group</button>
          </div>
        </div>

        <div className="field">
          <span>Registered feeds ({registry.feeds.length})</span>
          <ul className="panel__feeds">
            {registry.feeds.length === 0 && <li className="panel__empty">Nothing registered yet.</li>}
            {registry.feeds.map((f) => (
              <li key={f.id}>
                <span className="panel__label">{f.label}</span>
                <select value={f.groupId} onChange={(e) => props.onChange({
                  ...registry,
                  feeds: registry.feeds.map((x) => x.id === f.id ? { ...x, groupId: e.target.value } : x),
                })}>
                  {registry.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <span className="panel__src" title={f.src}>{f.src}</span>
                <button type="button" onClick={() => props.onChange({
                  ...registry, feeds: registry.feeds.filter((x) => x.id !== f.id),
                })}>remove</button>
              </li>
            ))}
          </ul>
        </div>

        <div className="modal__actions">
          <button type="button" onClick={() => props.onChange(DEFAULT_REGISTRY)}>reset to defaults</button>
          <button type="button" className="on" onClick={props.onClose}>done</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [registry, setRegistry] = useState<Registry>(() => loadRegistry());
  const [activeGroup, setActiveGroup] = useState<string>(() => loadRegistry().groups[0]?.id ?? '');
  const [panelOpen, setPanelOpen] = useState(false);
  const [audible, setAudible] = useState<Record<string, boolean>>({});
  const [faults, setFaults] = useState<Record<string, Fault>>({});
  const [statuses, setStatuses] = useState<Record<string, WorkerStatus>>({});
  const [jank, setJank] = useState(false);
  const [showNaive, setShowNaive] = useState(false);
  const [wallFps, setWallFps] = useState(0);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [clock, setClock] = useState(() => new Date().toLocaleTimeString());
  const [elVersion, setElVersion] = useState(0);

  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [reporting, setReporting] = useState<{ id: string; cam: string; evidence: Escalation['evidence'] } | null>(null);
  const [autoPromote, setAutoPromote] = useState(true);
  const [manualIds, setManualIds] = useState<string[]>([]);
  const [resolving, setResolving] = useState<Record<string, number>>({});

  const workerRef = useRef<Worker | null>(null);
  const elsRef = useRef<Record<string, HTMLVideoElement | null>>({});
  const prevLiveness = useRef<Record<string, Liveness>>({});
  const perf = useLongTasks();
  useJankInjector(jank);

  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date().toLocaleTimeString()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Only the ACTIVE group is mounted. Decode is the ceiling — one decoder per
  // feed — so tabs are what make a large registry affordable rather than a way
  // to tidy the UI.
  const tiles = useMemo(
    () => registry.feeds.filter((f) => f.groupId === activeGroup)
      .map((f) => ({ id: f.id, label: f.label, src: f.src, faultable: true })),
    [registry.feeds, activeGroup],
  );

  useEffect(() => { saveRegistry(registry); }, [registry]);

  useEffect(() => {
    if (!registry.groups.some((g) => g.id === activeGroup)) {
      setActiveGroup(registry.groups[0]?.id ?? '');
    }
  }, [registry.groups, activeGroup]);

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

  // Incident log + resolve-hold.
  useEffect(() => {
    const add: Incident[] = [];
    const recovered: string[] = [];
    for (const t of tiles) {
      const now = statuses[t.id]?.liveness;
      if (!now) continue;
      const was = prevLiveness.current[t.id];
      if (was && was !== now) {
        if (now === 'stale') add.push({ at: new Date().toLocaleTimeString(), cam: t.label, text: 'signal lost — frames stopped arriving', kind: 'lost' });
        else if (was === 'stale') { add.push({ at: new Date().toLocaleTimeString(), cam: t.label, text: 'signal restored', kind: 'restored' }); recovered.push(t.id); }
      }
      prevLiveness.current[t.id] = now;
    }
    if (add.length) setIncidents((prev) => [...add, ...prev].slice(0, 40));
    if (recovered.length) {
      setResolving((prev) => {
        const next = { ...prev };
        for (const id of recovered) next[id] = Date.now() + RESOLVE_HOLD_MS;
        return next;
      });
    }
  }, [statuses, tiles]);

  // Retire holds — this is what shrinks a recovered feed back to the carousel.
  useEffect(() => {
    if (!Object.keys(resolving).length) return;
    const t = window.setInterval(() => {
      const now = Date.now();
      setResolving((prev) => {
        const next: Record<string, number> = {};
        let changed = false;
        for (const [id, until] of Object.entries(prev)) { if (until > now) next[id] = until; else changed = true; }
        return changed ? next : prev;
      });
    }, 400);
    return () => window.clearInterval(t);
  }, [resolving]);

  const staleIds = useMemo(
    () => tiles.filter((t) => statuses[t.id]?.liveness === 'stale').map((t) => t.id),
    [tiles, statuses],
  );

  /**
   * Who occupies the main area. Manual picks always count; with auto-promote on,
   * anything in signal loss joins them, and anything that just recovered lingers
   * for RESOLVE_HOLD_MS so its toast can be read.
   */
  const heroIds = useMemo(() => {
    const set = new Set(manualIds);
    if (autoPromote) {
      staleIds.forEach((id) => set.add(id));
      Object.keys(resolving).forEach((id) => set.add(id));
    }
    return tiles.filter((t) => set.has(t.id)).map((t) => t.id);   // stable order
  }, [manualIds, autoPromote, staleIds, resolving, tiles]);

  const heroKey = heroIds.join(',');
  const layout = useMemo(() => computeLayout(tiles.map((t) => t.id), heroIds), [tiles, heroKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onToggleFocus = useCallback((id: string) => {
    setManualIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);
  const clearFocus = useCallback(() => { setManualIds([]); setResolving({}); }, []);

  useEffect(() => {
    if (!heroKey) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clearFocus(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [heroKey, clearFocus]);

  useEffect(() => {
    setManualIds((prev) => prev.filter((id) => tiles.some((t) => t.id === id)));
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
  const onEl = useCallback((id: string, el: HTMLVideoElement | null) => {
    if (elsRef.current[id] === el) return;
    elsRef.current[id] = el;
    setElVersion((v) => v + 1);
  }, []);
  const onFps = useCallback((f: number) => setWallFps(f), []);
  const onToggleAudio = useCallback((id: string) => {
    setAudible((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);
  const onReport = useCallback((id: string, cam: string, evidence: Escalation['evidence']) => {
    setReporting({ id, cam, evidence });
  }, []);
  // Deliberately NOT nesting setEscalations inside a setReporting updater:
  // React invokes updater functions twice under StrictMode, which duplicated
  // every escalation. Updaters must be pure; read the pending value directly.
  const submitEscalation = useCallback((severity: Escalation['severity'], note: string) => {
    if (!reporting) return;
    const entry: Escalation = {
      id: `${reporting.id}-${Date.now()}`,
      at: new Date().toLocaleTimeString(),
      cam: reporting.cam, severity, note: note.trim(), evidence: reporting.evidence,
    };
    setEscalations((prev) => [entry, ...prev].slice(0, 50));
    setReporting(null);
  }, [reporting]);

  const wallStreams: WallStreamRef[] = useMemo(
    () => tiles.map((t) => ({ id: t.id, el: elsRef.current[t.id] ?? null })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tiles, elVersion],
  );

  const statusById = useMemo(() => {
    const m: Record<string, Liveness> = {};
    for (const t of tiles) m[t.id] = statuses[t.id]?.liveness ?? 'idle';
    return m;
  }, [tiles, statuses]);

  const liveCount = tiles.filter((t) => statuses[t.id]?.liveness === 'live').length;

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
        <div><span>signal lost</span><strong className={staleIds.length ? 'bad' : ''}>{staleIds.length}</strong></div>
        <div><span>promoted</span><strong>{heroIds.length}</strong></div>
        <div><span>wall fps</span><strong>{wallFps.toFixed(0)}</strong></div>
        <div><span>long tasks</span><strong className={perf.longTasks ? 'warn' : ''}>{perf.longTasks}</strong></div>
        <div><span>blocking</span><strong>{(perf.blockedMs / 1000).toFixed(1)}s</strong></div>
      </section>

      <section className="controls">
        <div className="tabs" role="tablist" aria-label="Feed groups">
          {registry.groups.map((g) => {
            const count = registry.feeds.filter((f) => f.groupId === g.id).length;
            return (
              <button key={g.id} role="tab" aria-selected={g.id === activeGroup}
                className={g.id === activeGroup ? 'tab on' : 'tab'}
                onClick={() => setActiveGroup(g.id)}>
                {g.name}<span className="tab__count">{count}</span>
              </button>
            );
          })}
        </div>
        <button onClick={() => setPanelOpen(true)}>manage feeds</button>
        <button className={autoPromote ? 'on' : ''} onClick={() => setAutoPromote((v) => !v)}
          title="Promote any feed that loses signal into the main area automatically">
          auto-promote on signal loss: {autoPromote ? 'on' : 'off'}
        </button>
        <button className={jank ? 'on' : ''} onClick={() => setJank((v) => !v)}>
          {jank ? 'stop main-thread jank' : 'inject main-thread jank'}
        </button>
        <button className={showNaive ? 'on' : ''} onClick={() => setShowNaive((v) => !v)}>
          {showNaive ? 'showing: naive "is it connected?"' : 'showing: frame-aware watchdog'}
        </button>
        {heroIds.length > 0 && <button onClick={clearFocus}>✕ back to wall (Esc)</button>}
      </section>

      <div className="stage">
        <div className="wall-host">
          <VideoWall streams={wallStreams} statusById={statusById}
            heroIds={heroIds} onToggleFocus={onToggleFocus} onFps={onFps} />
          <div className="overlays">
            {tiles.map((t) => (
              <Stream key={t.id} id={t.id} label={t.label} src={t.src}
                fault={faults[t.id] ?? 'none'} box={layout.get(t.id)}
                isHero={heroIds.includes(t.id)} resolved={!!resolving[t.id]}
                status={statuses[t.id]} showNaive={showNaive}
                onFrame={onFrame} onIdle={onIdle} onEl={onEl}
                onFaultChange={onFaultChange} onToggleFocus={onToggleFocus}
                onReport={onReport} faultable={t.faultable}
                audible={!!audible[t.id]} onToggleAudio={onToggleAudio} />
            ))}
          </div>
        </div>

        <aside className="log">
          {escalations.length > 0 && (
            <>
              <h2>Escalations
                <button className="log__copy" title="Copy as JSON"
                  onClick={() => void navigator.clipboard?.writeText(JSON.stringify(escalations, null, 2))}>copy</button>
              </h2>
              <ul className="esc">
                {escalations.map((e) => (
                  <li key={e.id} className={`esc--${e.severity}`}>
                    <time>{e.at}</time>
                    <span className="log__cam">{e.cam}</span>
                    <span className="esc__sev">{e.severity}</span>
                    {e.note && <span className="esc__note">{e.note}</span>}
                    <span className="esc__ev">
                      {e.evidence.liveness} · stale {(e.evidence.staleMs / 1000).toFixed(1)}s · drift {e.evidence.drift == null ? '–' : e.evidence.drift.toFixed(2)} · dropped {e.evidence.dropped}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
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
            Promote a feed and hit <code>freeze</code> to cut it off at the client, or
            <code>report incident</code> to escalate with the measurements attached.
          </p>
        </aside>
      </div>

      {panelOpen && (
        <FeedPanel registry={registry} activeGroup={activeGroup}
          onChange={setRegistry} onClose={() => setPanelOpen(false)} />
      )}

      {reporting && (
        <ReportDialog pending={reporting} onSubmit={submitEscalation} onCancel={() => setReporting(null)} />
      )}
    </div>
  );
}
