/**
 * Feed registry: named groups of registered streams, persisted locally.
 *
 * Feeds are registered rather than hard-coded, and only the ACTIVE group is
 * mounted. That isn't a UI nicety — decode is the hard ceiling here (one
 * decoder per feed, and four concurrent 720p streams saturated the development
 * machine), so tabs are the mechanism that keeps a large registry affordable.
 */

export interface Feed {
  id: string;
  label: string;
  src: string;
  groupId: string;
}

export interface Group {
  id: string;
  name: string;
}

export interface Registry {
  groups: Group[];
  feeds: Feed[];
}

const STORAGE_KEY = 'liveview-watchdog:registry:v1';

/**
 * Seeded with the two feeds verified working on 2026-08-05 — real broadcast
 * footage, live, with CORS on playlist AND segments. See README for the ones
 * that failed and why.
 */
export const DEFAULT_REGISTRY: Registry = {
  groups: [
    { id: 'g-news', name: 'News' },
    { id: 'g-scratch', name: 'Scratch' },
  ],
  feeds: [
    {
      id: 'f-dw', label: 'DW-EN', groupId: 'g-news',
      src: 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8',
    },
    {
      id: 'f-tagesschau', label: 'TAGESSCHAU', groupId: 'g-news',
      src: 'https://tagesschau.akamaized.net/hls/live/2020115/tagesschau/tagesschau_1/master.m3u8',
    },
  ],
};

export function loadRegistry(): Registry {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_REGISTRY;
    const parsed = JSON.parse(raw) as Registry;
    if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.feeds)) return DEFAULT_REGISTRY;
    if (!parsed.groups.length) return DEFAULT_REGISTRY;
    return parsed;
  } catch {
    return DEFAULT_REGISTRY;
  }
}

export function saveRegistry(r: Registry) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(r)); } catch { /* quota / private mode */ }
}

// ── validation ─────────────────────────────────────────────────────────────

export type ProbeVerdict = 'live' | 'vod' | 'cors' | 'http' | 'not-hls' | 'unknown';

export interface ProbeResult {
  verdict: ProbeVerdict;
  ok: boolean;
  detail: string;
}

/**
 * Check a URL before it joins the wall.
 *
 * This encodes what a survey of public streams actually turns up, because none
 * of it is guessable from the URL:
 *   - most published "test streams" are VOD, and VOD is useless for a live
 *     view — hls.js buffers the whole asset, so it can never be starved and no
 *     live-edge behaviour occurs;
 *   - some hosts serve the playlist with CORS but NOT the segments, which
 *     looks fine here and then fails at playback;
 *   - some masters advertise variants that 404.
 *
 * So: resolve one level of variant, check for EXT-X-ENDLIST there, and fetch a
 * real segment to confirm the media itself is reachable cross-origin.
 */
export async function probeFeed(url: string, signal?: AbortSignal): Promise<ProbeResult> {
  let text: string;
  try {
    const res = await fetch(url, { mode: 'cors', signal });
    if (!res.ok) return { verdict: 'http', ok: false, detail: `Playlist returned HTTP ${res.status}.` };
    text = await res.text();
  } catch {
    return {
      verdict: 'cors', ok: false,
      detail: 'Blocked or unreachable. Usually no Access-Control-Allow-Origin header — the browser will not play it.',
    };
  }

  if (!text.includes('#EXTM3U')) {
    return { verdict: 'not-hls', ok: false, detail: 'Not an HLS playlist (no #EXTM3U).' };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { verdict: 'vod', ok: false, detail: 'This is VOD, not live. It cannot go stale, so the watchdog has nothing to watch.' };
  }

  // Master playlist → resolve one variant and re-check there.
  const isMaster = text.includes('#EXT-X-STREAM-INF');
  let mediaUrl = url;
  let mediaText = text;
  if (isMaster) {
    const rel = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && l.includes('m3u8'));
    if (!rel) return { verdict: 'not-hls', ok: false, detail: 'Master playlist lists no variants.' };
    mediaUrl = new URL(rel, url).toString();
    try {
      const r = await fetch(mediaUrl, { mode: 'cors', signal });
      if (!r.ok) return { verdict: 'http', ok: false, detail: `Variant playlist returned HTTP ${r.status} — the master advertises a rendition that isn't there.` };
      mediaText = await r.text();
    } catch {
      return { verdict: 'cors', ok: false, detail: 'Variant playlist blocked cross-origin.' };
    }
    if (mediaText.includes('#EXT-X-ENDLIST')) {
      return { verdict: 'vod', ok: false, detail: 'Variant is VOD, not live.' };
    }
  }

  // Segments must be reachable cross-origin too — a playlist-only CORS policy
  // passes every check above and then fails the moment playback starts.
  const seg = mediaText.split('\n').map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (seg) {
    try {
      const segUrl = new URL(seg, mediaUrl).toString();
      const r = await fetch(segUrl, { mode: 'cors', signal, headers: { Range: 'bytes=0-1' } });
      if (!r.ok && r.status !== 206) {
        return { verdict: 'http', ok: false, detail: `Segment returned HTTP ${r.status}.` };
      }
    } catch {
      return {
        verdict: 'cors', ok: false,
        detail: 'Playlist is CORS-enabled but its SEGMENTS are not. This passes a naive check and then fails at playback.',
      };
    }
  }

  return { verdict: 'live', ok: true, detail: 'Live, CORS-clean on playlist and segments.' };
}

// ── catalogue ──────────────────────────────────────────────────────────────

export interface CatalogEntry {
  label: string;
  /** Short tile code — explicit, rather than derived from the display name. */
  code: string;
  url: string;
  /** What it is, and anything known about how it behaves. */
  note: string;
}

/**
 * Prefilled feeds, all verified in a browser on 2026-08-05 — live, with CORS on
 * playlist AND segments. Offered as a starting point so you aren't pasting URLs
 * to find out which of the public endpoints still work; the probe still runs on
 * whatever you pick, because these rot.
 */
export const FEED_CATALOG: CatalogEntry[] = [
  {
    label: 'DW English', code: 'DW-EN',
    url: 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8',
    note: 'Deutsche Welle — live news, real footage, multi-variant',
  },
  {
    label: 'ARD Tagesschau', code: 'TAGESSCHAU',
    url: 'https://tagesschau.akamaized.net/hls/live/2020115/tagesschau/tagesschau_1/master.m3u8',
    note: 'German public broadcaster — live news, real footage',
  },
  {
    label: 'Unified Streaming — live', code: 'UNIFIED-A',
    url: 'https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8',
    note: 'Colour-bar test pattern with a burned-in clock — useful for verifying staleness by eye',
  },
  {
    label: 'Unified Streaming — SCTE-35', code: 'UNIFIED-B',
    url: 'https://demo.unified-streaming.com/k8s/live/stable/scte35.isml/.m3u8',
    note: 'Second test-pattern channel, distinct from the one above',
  },
  {
    label: 'Apple bipbop (VOD — will be rejected)', code: 'BIPBOP',
    url: 'https://d2zihajmogu5jn.cloudfront.net/bipbop-advanced/bipbop_16x9_variant.m3u8',
    note: 'Deliberately included: VOD, so the probe rejects it. Shows what a bad feed looks like.',
  },
];
