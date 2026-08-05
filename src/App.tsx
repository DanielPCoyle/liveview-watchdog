import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CreatableSelect from 'react-select/creatable';
import { useTile } from './useTile';
import { useLongTasks, useJankInjector } from './perf';
import { VideoWall, computeLayout, emphasize, VW, VH, type Box, type WallStreamRef } from './VideoWall';
import type { Fault, FromWorker, Liveness, ToWorker } from './types';
import {
  loadRegistry, saveRegistry, probeFeed,
  DEFAULT_REGISTRY, FEED_CATALOG, type Registry, type ProbeResult,
} from './feeds';

/**
 * Local live-HLS cameras from `scripts/cameras.sh` — genuinely live: sliding
 * playlist window, 1s segments, no EXT-X-ENDLIST.
 *
 * Public "test streams" are VOD. hls.js buffers a VOD asset end-to-end, so it
 * can't be starved and none of the live-edge behaviour this project measures
 * ever happens. Using them here would have been a demo of the wrong thing.
 */
/**
 * Material Symbols, inlined rather than loaded as a font.
 *
 * Two glyphs do not justify a webfont request on a page whose whole job is to
 * keep decoding video, and the wall should not go iconless because fonts.gstatic
 * is unreachable. Paths are the official 24px outlined set (Apache-2.0).
 */
const ICONS = {
  warning: 'm40-120 440-760 440 760H40Zm138-80h604L480-720 178-200Zm330.5-51.5Q520-263 520-280t-11.5-28.5Q497-320 480-320t-28.5 11.5Q440-297 440-280t11.5 28.5Q463-240 480-240t28.5-11.5ZM440-360h80v-200h-80v200Zm40-100Z',
  description: 'M320-240h320v-80H320v80Zm0-160h320v-80H320v80ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z',
} as const;

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="icon" viewBox="0 -960 960 960" aria-hidden focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}

const DEGRADED_AFTER_MS = 400;
const STALE_AFTER_MS = 1200;

/**
 * How long a recovered feed stays promoted after its signal returns. Snapping
 * it back the instant frames resume is worse than not promoting it: the tile
 * vanishes with no explanation. Hold it, say "signal restored", then shrink.
 */
const RESOLVE_HOLD_MS = 4000;

interface WorkerStatus { liveness: Liveness; staleMs: number; drift: number | null }

/**
 * Consecutive worker ticks a state must hold before it counts.
 *
 * Without this, a feed under load flaps: the machine stalls a decode for a
 * moment, the watchdog correctly calls it stale, it recovers, and the cycle
 * repeats — producing an incident log with a dozen lost/restored pairs in
 * twenty seconds and a tile that jumps in and out of the main area. Each
 * individual reading is true; the sequence is still useless to an operator.
 *
 * Detection stays fast (the worker ticks every 100ms) but must be sustained
 * before it is treated as an event.
 */
const CONFIRM_TICKS = 12;
/**
 * `feedId` as well as `cam`: labels are neither unique nor stable — two feeds
 * can carry the same name and editing one renames it — so grouping a feed's own
 * history by its display name would attach incidents to the wrong camera.
 */
interface Incident { at: string; feedId: string; cam: string; text: string; kind: 'lost' | 'restored' }

/**
 * An escalation is a snapshot, not a message. The evidence is captured at the
 * moment of reporting — liveness, how long it has been stale, media drift,
 * decode and drop counts — so the person receiving it gets numbers rather than
 * "camera 3 looks funny". That is the difference between a ticket someone can
 * action and one that starts with a round of questions.
 */
interface Escalation {
  id: string;
  feedId: string;
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
  /** Pointed at from the roster — this tile is swollen and must be in front. */
  isHovered: boolean;
  status: WorkerStatus | undefined; showNaive: boolean; audible: boolean;
  onToggleAudio: (id: string) => void;
  onFrame: (id: string, at: number, mediaTime: number) => void;
  onIdle: (id: string) => void;
  onEl: (id: string, el: HTMLVideoElement | null) => void;
  onFaultChange: (id: string, f: Fault) => void;
  onToggleFocus: (id: string) => void;
  onReport: (id: string, cam: string, ev: Escalation['evidence']) => void;
  onRemove: (id: string) => void;
  /**
   * Bumped when the roster asks THIS feed to be escalated. The roster cannot
   * assemble the evidence itself — decode counts live with the decoder, which
   * is here — so it names a feed and the feed answers with its own numbers.
   */
  reportNonce: number;
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

  // Snapshot the evidence at the moment of reporting, from the component that
  // actually owns the decoder.
  const snapshot = (): Escalation['evidence'] => ({
    liveness, staleMs: st?.staleMs ?? 0, drift: st?.drift ?? null,
    decoded: stats.totalFrames, dropped: stats.droppedFrames,
    droppedPct: stats.droppedPct, source: props.src,
  });

  const { reportNonce } = props;
  useEffect(() => {
    if (!reportNonce) return;
    props.onReport(props.id, props.label, snapshot());
    // Only the nonce fires this. Depending on the stats would re-send the
    // escalation every 400ms tick; the point is a reading taken *then*.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportNonce]);

  return (
    <>
      {/* The decoder. Hidden by CSS rather than portalled elsewhere: moving an
          element between parents remounts it, which tears down the hls.js
          attachment and leaves a dead readyState-0 element behind. */}
      <video className="decoder" ref={videoRef} muted playsInline />
      {props.box && (
        <div className={`ov ov--${shown} ${props.isHero ? 'ov--hero' : ''} ${props.isHovered ? 'ov--front' : ''}`} style={pct(props.box)}
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
            <button className="ov__remove" title={`Remove ${props.label}`}
              aria-label={`Remove ${props.label}`}
              onClick={(e) => { e.stopPropagation(); props.onRemove(props.id); }}>×</button>
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
                  props.onReport(props.id, props.label, snapshot());
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
 * Groups only. Adding and removing FEEDS happens on the grid itself, in the
 * slot the feed will occupy — a registry of streams is inherently spatial, and
 * a modal list makes you hold the wall in your head to use it.
 */
function GroupPanel(props: {
  registry: Registry;
  onChange: (r: Registry) => void;
  onClose: () => void;
}) {
  const { registry } = props;
  const [name, setName] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Manage groups"
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal__panel">
        <h2>Groups</h2>
        <ul className="panel__groups">
          {registry.groups.map((g) => {
            const count = registry.feeds.filter((f) => f.groupId === g.id).length;
            return (
              <li key={g.id}>
                <input value={g.name} aria-label={`Rename ${g.name}`}
                  onChange={(e) => props.onChange({
                    ...registry,
                    groups: registry.groups.map((x) => x.id === g.id ? { ...x, name: e.target.value } : x),
                  })} />
                <span className="panel__count">{count} feed{count === 1 ? '' : 's'}</span>
                <button type="button" disabled={registry.groups.length <= 1}
                  title={registry.groups.length <= 1 ? 'Keep at least one group' : 'Remove group and its feeds'}
                  onClick={() => props.onChange({
                    groups: registry.groups.filter((x) => x.id !== g.id),
                    feeds: registry.feeds.filter((f) => f.groupId !== g.id),
                  })}>remove</button>
              </li>
            );
          })}
        </ul>
        <div className="panel__add">
          <input placeholder="New group name" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" disabled={!name.trim()} onClick={() => {
            props.onChange({ ...registry, groups: [...registry.groups, { id: `g-${Date.now().toString(36)}`, name: name.trim() }] });
            setName('');
          }}>add group</button>
        </div>
        <div className="modal__actions">
          <button type="button" onClick={() => props.onChange(DEFAULT_REGISTRY)}>reset to defaults</button>
          <button type="button" className="on" onClick={props.onClose}>done</button>
        </div>
      </div>
    </div>
  );
}

interface FeedOption { value: string; label: string; note?: string }

const CATALOG_OPTIONS: FeedOption[] = FEED_CATALOG.map((c) => ({
  value: c.url, label: c.label, note: c.note,
}));

/**
 * react-select renders its own DOM, so it needs explicit theming rather than a
 * stylesheet — otherwise it arrives as a white control in a dark room.
 */
const selectStyles = {
  control: (b: Record<string, unknown>) => ({
    ...b, background: 'var(--panel-2)', borderColor: 'var(--rule)', borderRadius: 4,
    minHeight: 34, boxShadow: 'none', fontSize: 12, ':hover': { borderColor: 'var(--muted)' },
  }),
  menu: (b: Record<string, unknown>) => ({
    ...b, background: 'var(--panel)', border: '1px solid var(--rule)', borderRadius: 4, zIndex: 30,
  }),
  option: (b: Record<string, unknown>, st: { isFocused: boolean }) => ({
    ...b, background: st.isFocused ? 'color-mix(in srgb, var(--ink) 12%, transparent)' : 'transparent',
    color: 'var(--ink)', fontSize: 12, padding: '8px 10px', cursor: 'pointer',
  }),
  singleValue: (b: Record<string, unknown>) => ({ ...b, color: 'var(--ink)' }),
  input: (b: Record<string, unknown>) => ({ ...b, color: 'var(--ink)' }),
  placeholder: (b: Record<string, unknown>) => ({ ...b, color: 'var(--muted)' }),
  indicatorSeparator: (b: Record<string, unknown>) => ({ ...b, background: 'var(--rule)' }),
  dropdownIndicator: (b: Record<string, unknown>) => ({ ...b, color: 'var(--muted)' }),
} as never;

/**
 * Register one feed. The probe is the point: a URL cannot tell you whether it
 * is live or VOD, whether a master advertises variants that 404, or whether the
 * SEGMENTS are CORS-enabled as well as the playlist — and each of those fails
 * confusingly later rather than here.
 */
function FeedDialog(props: {
  groupName: string;
  /** Present when editing an existing feed rather than registering a new one. */
  initial?: { label: string; src: string };
  onSave: (label: string, src: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(props.initial?.label ?? '');
  const [src, setSrc] = useState(props.initial?.src ?? '');
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  // An unchanged source was already vetted when it was registered, so a rename
  // does not have to re-probe. Point it somewhere new and it does.
  const srcUnchanged = props.initial != null && src.trim() === props.initial.src;
  const canSave = (probe?.ok || srcUnchanged) && !!src.trim();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const check = async () => {
    if (!src.trim()) return;
    setProbing(true); setProbe(null);
    setProbe(await probeFeed(src.trim()));
    setProbing(false);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true"
      aria-label={props.initial ? 'Edit feed' : 'Add feed'}
      onClick={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <form className="modal__panel" onSubmit={(e) => { e.preventDefault(); if (canSave) props.onSave(label, src); }}>
        <h2>{props.initial ? `Edit “${props.initial.label}”` : `Add feed to “${props.groupName}”`}</h2>

        <label className="field">
          <span>Label</span>
          <input value={label} autoFocus placeholder="e.g. LOBBY-01" onChange={(e) => setLabel(e.target.value)} />
        </label>

        <div className="field">
          <span>Feed</span>
          <CreatableSelect<FeedOption>
            options={CATALOG_OPTIONS}
            styles={selectStyles}
            classNamePrefix="rs"
            placeholder="Pick a verified feed, or paste any .m3u8 URL…"
            formatCreateLabel={(v) => `Use custom URL: ${v}`}
            isClearable
            value={src ? (CATALOG_OPTIONS.find((o) => o.value === src) ?? { value: src, label: src }) : null}
            formatOptionLabel={(o: FeedOption, meta) => (
              meta.context === 'menu' && o.note
                ? <div><div>{o.label}</div><div className="rs__note">{o.note}</div></div>
                : <span>{o.label}</span>
            )}
            onChange={(opt) => {
              setSrc(opt?.value ?? '');
              setProbe(null);
              // Prefill the label from the catalogue, but never clobber a typed one.
              if (opt && !label.trim()) {
                const known = FEED_CATALOG.find((c) => c.url === opt.value);
                if (known) setLabel(known.code);
              }
            }}
          />
        </div>

        {probe && (
          <p className={`probe probe--${probe.ok ? 'ok' : 'bad'}`}>
            <strong>{probe.verdict}</strong> — {probe.detail}
          </p>
        )}

        <div className="modal__actions">
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="button" onClick={check} disabled={!src.trim() || probing}>
            {probing ? 'checking…' : 'check'}
          </button>
          {probe && !probe.ok && (
            <button type="button" onClick={() => props.onSave(label, src)}>
              {props.initial ? 'save anyway' : 'add anyway'}
            </button>
          )}
          <button type="submit" className="on" disabled={!canSave}>
            {props.initial ? 'save' : 'add'}
          </button>
        </div>
      </form>
    </div>
  );
}

interface Tile { id: string; label: string; src: string; faultable: boolean }

/**
 * Everything known about ONE feed, in one place.
 *
 * This is what the incident log used to be, cut per camera. A shared log is
 * fine while you are watching it happen and useless afterwards: the question an
 * operator actually asks is "what has THIS camera been doing", and answering it
 * from a merged stream means reading past everyone else's events.
 */
function FeedReport(props: {
  tile: Tile;
  liveness: Liveness;
  status: WorkerStatus | undefined;
  incidents: Incident[];
  escalations: Escalation[];
  onClose: () => void;
}) {
  const { tile, incidents, escalations, status, liveness } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const lost = incidents.filter((i) => i.kind === 'lost').length;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Report for ${tile.label}`}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal__panel report">
        <h2>
          {tile.label}
          <button className="log__copy" title="Copy this feed's report as JSON"
            onClick={() => void navigator.clipboard?.writeText(JSON.stringify(
              { feed: tile.label, source: tile.src, liveness, incidents, escalations }, null, 2,
            ))}>copy</button>
        </h2>

        <dl className="evidence">
          <div><dt>liveness</dt><dd className={liveness === 'stale' ? 'bad' : ''}>{liveness}</dd></div>
          <div><dt>stale for</dt><dd>{((status?.staleMs ?? 0) / 1000).toFixed(1)}s</dd></div>
          <div><dt>media drift</dt><dd className={status?.drift != null && status.drift < 0.35 ? 'bad' : ''}>
            {status?.drift == null ? '–' : status.drift.toFixed(2)}</dd></div>
          <div><dt>signal lost</dt><dd className={lost ? 'bad' : ''}>{lost}×</dd></div>
          <div className="evidence__src"><dt>source</dt><dd>{tile.src}</dd></div>
        </dl>

        {escalations.length > 0 && (
          <div className="field">
            <span>Escalations</span>
            <ul className="esc">
              {escalations.map((e) => (
                <li key={e.id} className={`esc--${e.severity}`}>
                  <time>{e.at}</time>
                  <span className="esc__sev">{e.severity}</span>
                  {e.note && <span className="esc__note">{e.note}</span>}
                  <span className="esc__ev">
                    {e.evidence.liveness} · stale {(e.evidence.staleMs / 1000).toFixed(1)}s · drift{' '}
                    {e.evidence.drift == null ? '–' : e.evidence.drift.toFixed(2)} · dropped {e.evidence.dropped}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="field">
          <span>History</span>
          {incidents.length === 0 ? (
            <p className="log__empty">No signal loss recorded for this feed.</p>
          ) : (
            <ul className="report__log">
              {incidents.map((i, n) => (
                <li key={n} className={i.kind}>
                  <time>{i.at}</time>
                  <span>{i.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="modal__actions">
          <button type="button" className="on" onClick={props.onClose}>close</button>
        </div>
      </div>
    </div>
  );
}

const FILTERS = ['all', 'live', 'degraded', 'stale'] as const;
type FilterKey = (typeof FILTERS)[number];

/**
 * Below this width the wall stops being worth compositing. A phone fits one or
 * two tiles at a legible size, so a GPU surface plus a DOM overlay per tile
 * buys nothing over the frames we are already decoding — and a WebGL canvas
 * cannot scroll with a list. The roster becomes the whole app instead, and each
 * row draws its own picture.
 */
const LIST_MODE_MAX = 699;

function useListMode() {
  const query = `(max-width: ${LIST_MODE_MAX}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

/**
 * A row's picture, drawn from the decoder that already exists.
 *
 * Deliberately NOT a second <video> for the same stream: that is a second
 * decoder, and decode is the ceiling this whole project keeps running into —
 * the list would cost double what the wall costs. Deliberately not the wall's
 * canvas either, which cannot scroll with the rows.
 *
 * drawImage reads the decoded frame at its intrinsic size, so it works fine
 * against an element that is two pixels wide and effectively invisible, which
 * is exactly what the decoders are.
 */
function Thumb({ el, big }: { el: HTMLVideoElement | null; big: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !el) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      // ~12fps. It is a thumbnail: it only has to look alive. The pill beside
      // it is what actually reports liveness, and it is measured off decoded
      // frames rather than off anything drawn here.
      if (t - last < 80) return;
      last = t;
      if (el.readyState >= 2 && el.videoWidth) ctx.drawImage(el, 0, 0, c.width, c.height);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [el, big]);
  return (
    <canvas ref={ref} className="roster__thumb" aria-hidden
      width={big ? 480 : 160} height={big ? 270 : 90} />
  );
}

/**
 * Roster for the active group — one panel per group, showing only what that
 * group has mounted.
 *
 * The wall answers "is anything wrong". This answers "where is the one I'm
 * thinking of", which is a different question and the one that gets slow first.
 * At six feeds you scan the grid. At forty near-identical tiles you don't — and
 * the moment you most need LOT-07 is the moment you have the least attention
 * spare to hunt for it.
 *
 * Hovering PREVIEWS rather than navigates: the tile swells on the wall so the
 * row and the picture are tied together, without committing to a layout change
 * nobody asked for. Clicking is the commitment.
 */
function FeedRoster(props: {
  groupName: string;
  tiles: Tile[];
  statuses: Record<string, WorkerStatus>;
  heroIds: string[];
  ignored: Record<string, boolean>;
  audible: Record<string, boolean>;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
  onReport: (id: string) => void;
  onToggleIgnore: (id: string) => void;
  onToggleAudio: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onReorder: (dragId: string, dropId: string) => void;
  /** Narrow layout: the roster is the whole app, so it carries the picture. */
  listMode: boolean;
  elsById: Record<string, HTMLVideoElement | null>;
  faults: Record<string, Fault>;
  onToggleFreeze: (id: string) => void;
  onAdd: () => void;
  incidentsByFeed: Record<string, Incident[]>;
  escalationsByFeed: Record<string, Escalation[]>;
  onOpenReport: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const { tiles, statuses } = props;

  const livenessOf = useCallback(
    (id: string) => statuses[id]?.liveness ?? 'idle',
    [statuses],
  );

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: tiles.length, live: 0, degraded: 0, stale: 0 };
    for (const t of tiles) {
      const l = statuses[t.id]?.liveness;
      if (l && l !== 'idle') c[l] += 1;
    }
    return c;
  }, [tiles, statuses]);

  // Match the URL as well as the label: feeds get named after where they point
  // often enough that "akamai" or "tagesschau" is the thing actually in mind.
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tiles.filter((t) => {
      if (filter !== 'all' && livenessOf(t.id) !== filter) return false;
      if (!needle) return true;
      return t.label.toLowerCase().includes(needle) || t.src.toLowerCase().includes(needle);
    });
  }, [tiles, q, filter, livenessOf]);

  /**
   * Reordering is disabled while the list is narrowed, because "drop it below
   * the third row" has no defined meaning when rows are hidden — the operator
   * would be arranging a list they cannot see.
   */
  const narrowed = shown.length !== tiles.length;

  /** Same move as a drag, for people not using a mouse. */
  const nudge = (id: string, delta: number) => {
    const i = tiles.findIndex((t) => t.id === id);
    const target = tiles[i + delta];
    if (target) props.onReorder(id, target.id);
  };

  return (
    <aside className="roster" aria-label={`Feeds in ${props.groupName}`}>
      <h2>
        {props.groupName}
        <span className="roster__tally">
          {shown.length === tiles.length ? `${tiles.length}` : `${shown.length}/${tiles.length}`}
        </span>
      </h2>

      <input className="roster__search" type="search" value={q} placeholder="search feeds…"
        aria-label="Search feeds by name or source" onChange={(e) => setQ(e.target.value)} />

      <div className="roster__filters" role="group" aria-label="Filter by liveness">
        {FILTERS.map((f) => (
          <button key={f} className={filter === f ? 'on' : ''}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}>
            {f}<span className="roster__n">{counts[f]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="log__empty">
          {tiles.length === 0 ? 'No feeds in this group yet — use the empty slot on the wall.' : 'Nothing matches.'}
        </p>
      ) : (
        <ul className="roster__list">
          {shown.map((t) => {
            const live = livenessOf(t.id);
            const isHero = props.heroIds.includes(t.id);
            const ig = !!props.ignored[t.id];
            return (
              <li key={t.id}
                className={[
                  'roster__item', isHero ? 'on' : '', ig ? 'muted' : '',
                  dragId === t.id ? 'dragging' : '', overId === t.id && dragId !== t.id ? 'over' : '',
                ].filter(Boolean).join(' ')}
                draggable={!narrowed}
                onDragStart={(e) => {
                  setDragId(t.id);
                  e.dataTransfer.effectAllowed = 'move';
                  // Firefox starts no drag at all unless the payload is set.
                  e.dataTransfer.setData('text/plain', t.id);
                }}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverId(t.id); } }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId && dragId !== t.id) props.onReorder(dragId, t.id);
                  setDragId(null); setOverId(null);
                }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
                onMouseEnter={() => props.onHover(t.id)}
                onMouseLeave={() => props.onHover(null)}>
                <button className="roster__pick" aria-pressed={isHero}
                  title={isHero ? `Return ${t.label} to the wall` : `Bring ${t.label} into the main area`}
                  onFocus={() => props.onHover(t.id)}
                  onBlur={() => props.onHover(null)}
                  onClick={() => props.onPick(t.id)}
                  onKeyDown={(e) => {
                    if (!e.altKey || narrowed) return;
                    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                    e.preventDefault();
                    nudge(t.id, e.key === 'ArrowUp' ? -1 : 1);
                  }}>
                  {props.listMode && <Thumb el={props.elsById[t.id] ?? null} big={isHero} />}
                  <span className="roster__meta">
                    {!props.listMode && (
                      <span className="roster__grip" aria-hidden
                        title={narrowed ? 'Clear the search to reorder' : 'Drag to reorder — or alt + ↑/↓'}>⠿</span>
                    )}
                    <span className="roster__name">{t.label}</span>
                    <span className={`pill pill--${live}`}>
                      {live}{live !== 'idle' && live !== 'live' ? ` ${((statuses[t.id]?.staleMs ?? 0) / 1000).toFixed(1)}s` : ''}
                    </span>
                  </span>
                </button>

                {/* The incident log, cut per camera and folded into its row.
                    Latest event only — the rest is behind the report. */}
                <div className="roster__inc">
                  {(() => {
                    const inc = props.incidentsByFeed[t.id] ?? [];
                    const esc = props.escalationsByFeed[t.id] ?? [];
                    const latest = inc[0];
                    return (
                      <>
                        {latest ? (
                          <>
                            <span className={`roster__inc-icon ${latest.kind}`}><Icon name="warning" /></span>
                            <time>{latest.at}</time>
                            <span className="roster__inc-text">
                              {latest.kind === 'lost' ? 'signal lost' : 'restored'}
                            </span>
                            {inc.length > 1 && <span className="roster__inc-n">{inc.length}</span>}
                          </>
                        ) : (
                          <span className="roster__inc-none">no incidents</span>
                        )}
                        {esc.length > 0 && <span className="roster__inc-esc">{esc.length} escalated</span>}
                        <button className="roster__inspect" title={`Full report for ${t.label}`}
                          aria-label={`Full report for ${t.label}`}
                          onClick={() => props.onOpenReport(t.id)}>
                          <Icon name="description" />
                        </button>
                      </>
                    );
                  })()}
                </div>

                <div className="roster__actions">
                  {/* Touch has no drag-and-drop and no alt+arrow, so the same
                      move gets explicit controls when the list is the app. */}
                  {props.listMode && !narrowed && (
                    <>
                      <button aria-label={`Move ${t.label} up`} title="Move up"
                        disabled={tiles[0]?.id === t.id}
                        onClick={() => nudge(t.id, -1)}>↑</button>
                      <button aria-label={`Move ${t.label} down`} title="Move down"
                        disabled={tiles[tiles.length - 1]?.id === t.id}
                        onClick={() => nudge(t.id, 1)}>↓</button>
                    </>
                  )}
                  {/* The wall's fault controls live on a promoted tile, which
                      does not exist here — without this the list can show the
                      watchdog but never make it fire. */}
                  {props.listMode && (
                    <button className={props.faults[t.id] === 'freeze' ? 'on' : ''}
                      aria-pressed={props.faults[t.id] === 'freeze'}
                      title="Cut this feed off at the client: the buffer starves and the picture stops, with no error event"
                      onClick={() => props.onToggleFreeze(t.id)}>freeze</button>
                  )}
                  <button onClick={() => props.onReport(t.id)}
                    title={`Escalate ${t.label} with its measurements attached`}>report</button>
                  <button className={ig ? 'on' : ''} aria-pressed={ig}
                    onClick={() => props.onToggleIgnore(t.id)}
                    title={ig
                      ? `Stop ignoring ${t.label} — it can be auto-promoted again`
                      : `Acknowledge ${t.label}: keep monitoring and logging it, but stop promoting it`}>
                    {ig ? 'ignored' : 'ignore'}
                  </button>
                  <button onClick={() => props.onEdit(t.id)} title={`Rename or re-point ${t.label}`}>edit</button>
                  <button className={`roster__audio ${props.audible[t.id] ? 'on' : ''}`}
                    aria-label={props.audible[t.id] ? `Mute ${t.label}` : `Unmute ${t.label}`}
                    onClick={() => props.onToggleAudio(t.id)}>
                    {props.audible[t.id] ? '🔊' : '🔇'}
                  </button>
                  <button className="roster__remove" aria-label={`Remove ${t.label}`}
                    title={`Remove ${t.label} from this group`}
                    onClick={() => props.onRemove(t.id)}>×</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* The empty slot lives on the wall, and in list mode there is no wall. */}
      {props.listMode && (
        <button className="roster__add" onClick={props.onAdd}>+ add feed</button>
      )}

      <p className="log__note">
        <code>freeze</code> cuts a feed off at the client; <code>report</code> escalates it with
        the measurements attached. The document icon opens a feed's full history.
      </p>
    </aside>
  );
}

export default function App() {
  const [registry, setRegistry] = useState<Registry>(() => loadRegistry());
  const [activeGroup, setActiveGroup] = useState<string>(() => loadRegistry().groups[0]?.id ?? '');
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [adding, setAdding] = useState(false);
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

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  /** Feed whose full report is open. */
  const [inspecting, setInspecting] = useState<string | null>(null);
  /**
   * Acknowledged feeds. Deliberately NOT persisted: an acknowledgement is about
   * a shift, not about a camera, and one that silently survives a reload is how
   * a feed stays suppressed long after the person who suppressed it went home.
   */
  const [ignored, setIgnored] = useState<Record<string, boolean>>({});
  /** Roster escalation requests — see Stream's reportNonce. */
  const [reportReq, setReportReq] = useState<{ id: string; n: number } | null>(null);

  const listMode = useListMode();
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

  // Debounced view of liveness: what the UI, the incident log and auto-promote
  // all act on. Raw per-tick status still drives the pill so the operator sees
  // the truth immediately; only *events* require confirmation.
  const [confirmed, setConfirmed] = useState<Record<string, Liveness>>({});
  const pending = useRef<Record<string, { value: Liveness; count: number }>>({});

  useEffect(() => {
    let changed = false;
    const next = { ...confirmed };
    for (const t of tiles) {
      const now = statuses[t.id]?.liveness;
      if (!now) continue;
      const p = pending.current[t.id];
      if (!p || p.value !== now) {
        pending.current[t.id] = { value: now, count: 1 };
      } else {
        p.count += 1;
      }
      const cur = pending.current[t.id];
      if (next[t.id] === undefined) { next[t.id] = now; changed = true; }
      else if (cur.value !== next[t.id] && cur.count >= CONFIRM_TICKS) {
        next[t.id] = cur.value; changed = true;
      }
    }
    if (changed) setConfirmed(next);
  }, [statuses, tiles, confirmed]);

  // Incident log + resolve-hold.
  useEffect(() => {
    const add: Incident[] = [];
    const recovered: string[] = [];
    for (const t of tiles) {
      const now = confirmed[t.id];
      if (!now) continue;
      const was = prevLiveness.current[t.id];
      if (was && was !== now) {
        if (now === 'stale') add.push({ at: new Date().toLocaleTimeString(), feedId: t.id, cam: t.label, text: 'signal lost — frames stopped arriving', kind: 'lost' });
        else if (was === 'stale') { add.push({ at: new Date().toLocaleTimeString(), feedId: t.id, cam: t.label, text: 'signal restored', kind: 'restored' }); recovered.push(t.id); }
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
  }, [confirmed, tiles]);

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
    () => tiles.filter((t) => confirmed[t.id] === 'stale').map((t) => t.id),
    [tiles, confirmed],
  );

  /**
   * Who occupies the main area. Manual picks always count; with auto-promote on,
   * anything in signal loss joins them, and anything that just recovered lingers
   * for RESOLVE_HOLD_MS so its toast can be read.
   */
  const heroIds = useMemo(() => {
    const set = new Set(manualIds);
    if (autoPromote) {
      // Ignoring a feed suppresses PROMOTION, not measurement: it keeps being
      // watched, keeps counting as signal lost, and keeps writing to the
      // incident log. An acknowledgement that also stopped the monitoring would
      // be a mute button dressed up as an operator action. A manual pick still
      // overrides it — deliberately choosing a feed you ignored is not a
      // mistake to protect anyone from.
      staleIds.forEach((id) => { if (!ignored[id]) set.add(id); });
      Object.keys(resolving).forEach((id) => { if (!ignored[id]) set.add(id); });
    }
    return tiles.filter((t) => set.has(t.id)).map((t) => t.id);   // stable order
  }, [manualIds, autoPromote, staleIds, resolving, tiles, ignored]);

  const heroKey = heroIds.join(',');
  // The empty "add feed" slot occupies a real grid position, so it is part of
  // the layout rather than floated on top of it.
  const ADD_SLOT = '__add__';
  const layout = useMemo(
    () => {
      const base = computeLayout([...tiles.map((t) => t.id), ADD_SLOT], heroIds);
      return hoverId ? emphasize(base, hoverId) : base;
    },
    [tiles, heroKey, hoverId], // eslint-disable-line react-hooks/exhaustive-deps
  );

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
  const removeFeed = useCallback((id: string) => {
    setRegistry((r) => ({ ...r, feeds: r.feeds.filter((f) => f.id !== id) }));
  }, []);
  const addFeed = useCallback((label: string, src: string) => {
    setRegistry((r) => ({
      ...r,
      feeds: [...r.feeds, {
        id: `f-${Date.now().toString(36)}`,
        label: label.trim() || `FEED ${r.feeds.length + 1}`,
        src: src.trim(), groupId: activeGroup,
      }],
    }));
    setAdding(false);
  }, [activeGroup]);
  const editFeed = useCallback((label: string, src: string) => {
    if (!editing) return;
    setRegistry((r) => ({
      ...r,
      feeds: r.feeds.map((f) => (f.id === editing
        ? { ...f, label: label.trim() || f.label, src: src.trim() || f.src }
        : f)),
    }));
    setEditing(null);
  }, [editing]);
  /**
   * Move one feed to another's position within the active group.
   *
   * The roster order IS the wall order — the same array feeds computeLayout —
   * so dragging a row rearranges the grid rather than just the list. Anything
   * else would be two orderings to keep in your head.
   *
   * Other groups' feeds keep the exact slots they held in the registry array:
   * the reordered group is written back into the positions it already occupied.
   */
  const reorderFeed = useCallback((dragId: string, dropId: string) => {
    setRegistry((r) => {
      const inGroup = r.feeds.filter((f) => f.groupId === activeGroup);
      const from = inGroup.findIndex((f) => f.id === dragId);
      const to = inGroup.findIndex((f) => f.id === dropId);
      if (from < 0 || to < 0 || from === to) return r;
      const next = [...inGroup];
      next.splice(to, 0, next.splice(from, 1)[0]);
      let i = 0;
      return { ...r, feeds: r.feeds.map((f) => (f.groupId === activeGroup ? next[i++] : f)) };
    });
  }, [activeGroup]);
  const toggleIgnore = useCallback((id: string) => {
    setIgnored((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);
  const toggleFreeze = useCallback((id: string) => {
    setFaults((prev) => ({ ...prev, [id]: prev[id] === 'freeze' ? 'none' : 'freeze' }));
  }, []);
  const requestReport = useCallback((id: string) => {
    setReportReq((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
  }, []);
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
      feedId: reporting.id,
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

  const incidentsByFeed = useMemo(() => {
    const m: Record<string, Incident[]> = {};
    for (const i of incidents) (m[i.feedId] ??= []).push(i);
    return m;
  }, [incidents]);

  const escalationsByFeed = useMemo(() => {
    const m: Record<string, Escalation[]> = {};
    for (const e of escalations) (m[e.feedId] ??= []).push(e);
    return m;
  }, [escalations]);

  const elsById = useMemo(() => {
    const m: Record<string, HTMLVideoElement | null> = {};
    for (const s of wallStreams) m[s.id] = s.el;
    return m;
  }, [wallStreams]);

  const statusById = useMemo(() => {
    const m: Record<string, Liveness> = {};
    for (const t of tiles) m[t.id] = statuses[t.id]?.liveness ?? 'idle';
    return m;
  }, [tiles, statuses]);

  const liveCount = tiles.filter((t) => statuses[t.id]?.liveness === 'live').length;
  const ignoredCount = tiles.filter((t) => ignored[t.id]).length;

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
        {/* Suppression has to be visible. A feed quietly excluded from
            promotion is exactly the state an operator must not inherit blind. */}
        {ignoredCount > 0 && <div><span>ignored</span><strong className="warn">{ignoredCount}</strong></div>}
        {/* The escalations list now lives per feed, so the count is what keeps
            "somebody raised a ticket" visible without opening anything. */}
        {escalations.length > 0 && <div><span>escalated</span><strong className="warn">{escalations.length}</strong></div>}
        {/* No wall in list mode, so no wall fps — reporting 0 for a compositor
            that isn't running is the kind of confident-but-wrong number this
            project is about. */}
        {!listMode && <div><span>wall fps</span><strong>{wallFps.toFixed(0)}</strong></div>}
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
        <button onClick={() => setGroupsOpen(true)}>manage groups</button>
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

      <div className={`stage ${listMode ? 'stage--list' : ''}`}>
        <FeedRoster
          groupName={registry.groups.find((g) => g.id === activeGroup)?.name ?? 'Feeds'}
          tiles={tiles} statuses={statuses} heroIds={heroIds}
          ignored={ignored} audible={audible}
          onHover={setHoverId} onPick={onToggleFocus} onReport={requestReport}
          onToggleIgnore={toggleIgnore} onToggleAudio={onToggleAudio}
          onEdit={setEditing} onRemove={removeFeed} onReorder={reorderFeed}
          listMode={listMode} elsById={elsById} faults={faults}
          onToggleFreeze={toggleFreeze} onAdd={() => setAdding(true)}
          incidentsByFeed={incidentsByFeed} escalationsByFeed={escalationsByFeed}
          onOpenReport={setInspecting} />

        {/* The Streams stay mounted and in the same place in the tree in both
            layouts. Their <video> elements ARE the decoders — reparenting one
            remounts it and tears down the hls attachment, and display:none
            stops it decoding — so in list mode the host is collapsed to a
            pixel rather than removed, and only the canvas goes away. */}
        <div className="wall-host">
          {!listMode && (
            <VideoWall streams={wallStreams} statusById={statusById}
              heroIds={heroIds} hoverId={hoverId} layout={layout}
              onToggleFocus={onToggleFocus} onFps={onFps} />
          )}
          <div className="overlays">
            {tiles.map((t) => (
              <Stream key={t.id} id={t.id} label={t.label} src={t.src}
                fault={faults[t.id] ?? 'none'} box={listMode ? undefined : layout.get(t.id)}
                isHero={heroIds.includes(t.id)} resolved={!!resolving[t.id]}
                isHovered={hoverId === t.id}
                status={statuses[t.id]} showNaive={showNaive}
                onFrame={onFrame} onIdle={onIdle} onEl={onEl}
                onFaultChange={onFaultChange} onToggleFocus={onToggleFocus}
                onReport={onReport} faultable={t.faultable}
                reportNonce={reportReq?.id === t.id ? reportReq.n : 0}
                audible={!!audible[t.id]} onToggleAudio={onToggleAudio}
                onRemove={removeFeed} />
            ))}

            {/* Empty slot — registering a feed happens on the grid, in the
                position the feed will occupy, rather than in a modal list. */}
            {!listMode && layout.get(ADD_SLOT) && (
              <button className="ov ov--add" style={pct(layout.get(ADD_SLOT)!)}
                onClick={() => setAdding(true)}
                title="Register another feed">
                <span className="ov__plus">+</span>
                <span className="ov__addlabel">add feed</span>
              </button>
            )}
          </div>
        </div>

      </div>

      {groupsOpen && (
        <GroupPanel registry={registry} onChange={setRegistry} onClose={() => setGroupsOpen(false)} />
      )}

      {adding && (
        <FeedDialog groupName={registry.groups.find((g) => g.id === activeGroup)?.name ?? ''}
          onSave={addFeed} onCancel={() => setAdding(false)} />
      )}

      {editing && registry.feeds.some((f) => f.id === editing) && (
        <FeedDialog groupName={registry.groups.find((g) => g.id === activeGroup)?.name ?? ''}
          initial={(() => {
            const f = registry.feeds.find((x) => x.id === editing)!;
            return { label: f.label, src: f.src };
          })()}
          onSave={editFeed} onCancel={() => setEditing(null)} />
      )}

      {reporting && (
        <ReportDialog pending={reporting} onSubmit={submitEscalation} onCancel={() => setReporting(null)} />
      )}

      {inspecting && tiles.some((t) => t.id === inspecting) && (
        <FeedReport tile={tiles.find((t) => t.id === inspecting)!}
          liveness={statuses[inspecting]?.liveness ?? 'idle'}
          status={statuses[inspecting]}
          incidents={incidentsByFeed[inspecting] ?? []}
          escalations={escalationsByFeed[inspecting] ?? []}
          onClose={() => setInspecting(null)} />
      )}
    </div>
  );
}
