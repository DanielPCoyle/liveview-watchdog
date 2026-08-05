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

/** Bumped when the seeded defaults change — a persisted registry would
 *  otherwise pin the first run's feeds forever. */
const STORAGE_KEY = 'liveview-watchdog:registry:v3';

/** Caltrans publishes its highway CCTV as open HLS, CORS-clean. */
const CT = (path: string) => `https://wzmedia.dot.ca.gov/${path}.stream/playlist.m3u8`;

/**
 * Seeded with real public highway CCTV — Caltrans district cameras, verified
 * end-to-end on 2026-08-05: live (sliding window, no ENDLIST), CORS on the
 * playlist AND the segments, and delivering 5–9x faster than real time with all
 * four running at once, which is the part that actually decides whether a wall
 * is possible.
 *
 * Fixed cameras pointed at roads are the right demo material for this specific
 * tool, and not because they look the part. They are the hardest case for a
 * human watching a wall: the scene barely changes, so a frozen tile and a
 * working one are visually IDENTICAL until a car should have moved and didn't.
 * That is the failure this project exists to catch. Broadcast news, where a
 * freeze is obvious in about a second, quietly makes the problem look easier
 * than it is — so it is kept as a second group for contrast, and because it is
 * multi-variant, which the focused-quality policy needs to have anything to
 * switch between.
 *
 * Labels come from the stream path Caltrans publishes, not from a third-party
 * camera list — a tool about attaching verified evidence should not open by
 * guessing at which intersection you are looking at.
 */
export const DEFAULT_REGISTRY: Registry = {
  groups: [
    { id: 'g-street', name: 'Highway' },
    { id: 'g-news', name: 'News' },
    { id: 'g-scratch', name: 'Scratch' },
  ],
  feeds: [
    { id: 'f-ct55', label: 'I5-SR55', groupId: 'g-street', src: CT('D12/NB5SR55') },
    { id: 'f-ctoso', label: 'I5-OSOPKWY', groupId: 'g-street', src: CT('D12/NB5OsoPkwy') },
    { id: 'f-ct88', label: 'SR88-PINEGROVE', groupId: 'g-street', src: CT('D10/AMA_EB88_PineGrove') },
    // Deliberately NOT NB5CrownValley, which is in the catalogue instead: it
    // publishes irregularly enough to alarm on its own every minute or so. A
    // default wall that cries wolf out of the box teaches you to ignore it.
    { id: 'f-ct337', label: 'D7-CCTV337', groupId: 'g-street', src: CT('D7/CCTV-337') },
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
    label: 'Caltrans — NB I-5 at SR-55 (Orange)', code: 'I5-SR55',
    url: CT('D12/NB5SR55'),
    note: 'Public highway CCTV. 8s segments, ~5x real-time — comfortable on a wall',
  },
  {
    label: 'Caltrans — NB I-5 at Crown Valley Pkwy (flaps)', code: 'I5-CROWNVLY',
    url: CT('D12/NB5CrownValley'),
    // Measured 2026-08-05: the playlist's media sequence stood still for ~14s
    // at a time and then jumped two segments. Frames really do stop, so the
    // watchdog is right to call it — this is a true positive from a real
    // camera, not a tuning artefact, and it is the closest thing here to what
    // the tool is for.
    note: 'Publishes irregularly — genuinely stops for ~14s at a time. Alarms on its own, no fault injection needed.',
  },
  {
    label: 'Caltrans — NB I-5 at Oso Pkwy', code: 'I5-OSOPKWY',
    url: CT('D12/NB5OsoPkwy'),
    note: 'Public highway CCTV. 10s segments, ~5x real-time',
  },
  {
    label: 'Caltrans — EB SR-88 Pine Grove (Amador)', code: 'SR88-PINEGROVE',
    url: CT('D10/AMA_EB88_PineGrove'),
    note: 'Public highway CCTV, mountain road — very little motion, so a freeze is invisible by eye',
  },
  {
    label: 'Caltrans D7 — CCTV-337 (Los Angeles metro)', code: 'D7-CCTV337',
    url: CT('D7/CCTV-337'),
    note: 'Public highway CCTV. 250 kbps for 720p — the cheapest feed here',
  },
  {
    label: 'Caltrans D8 — I-10 postmile 515 (Riverside)', code: 'D8-I10-515',
    url: CT('D8/LB-8_10_515'),
    note: 'Public highway CCTV, 352x288 — a low-resolution sub-stream, which is what wall tiles should be',
  },
  {
    label: 'Arlington VA — traffic cam 58 (starved)', code: 'ARL-58',
    url: 'https://itsvideo.arlingtonva.us:8011/live/cam58.stream/playlist.m3u8',
    // Kept deliberately, like the VOD entry below. This one passes every check
    // the probe makes — live, CORS-clean on playlist and segments — and is
    // still unusable: measured on 2026-08-05 it served a 10-second segment in
    // ~14 seconds, so playback can never catch the live edge. It is the honest
    // example of a feed that is not "down" and not "up", and of why connection
    // state cannot answer the question.
    note: 'Real municipal CCTV that serves BELOW real time — passes every probe, then starves. Worth watching go stale.',
  },
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
