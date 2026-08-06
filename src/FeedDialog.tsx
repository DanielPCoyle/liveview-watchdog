import { useEffect, useState } from 'react';
import CreatableSelect from 'react-select/creatable';
import { probeFeed, FEED_CATALOG, type ProbeResult } from './feeds';

/**
 * Register or edit one feed.
 *
 * Split into its own module so `react-select` is fetched only when the dialog
 * is actually opened. The probe is the point of the whole screen: a URL cannot
 * tell you whether it is live or VOD, whether a master advertises variants that
 * 404, or whether the SEGMENTS are CORS-enabled as well as the playlist — and
 * each of those fails confusingly later rather than here.
 */
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
export default function FeedDialog(props: {
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
