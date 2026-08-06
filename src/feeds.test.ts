/**
 * `probeFeed` has the most branching in the codebase and every branch encodes
 * something learned the hard way from surveying real public streams — VOD
 * masquerading as live, masters advertising variants that 404, playlists that
 * are CORS-clean while their segments are not. Those are exactly the verdicts
 * that would rot silently if the logic drifted.
 *
 * Hermetic by construction: `fetch` is stubbed, so this suite never touches a
 * network. Run with `bun test`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { probeFeed, loadRegistry, DEFAULT_REGISTRY } from './feeds';

// mockMode() reads the URL, and another suite may have left ?mock=1 on it.
beforeEach(() => window.history.replaceState({}, '', '/'));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Serve canned bodies by URL substring; anything unmatched is a hard failure. */
function serve(routes: Array<[string, { status?: number; body?: string; throws?: boolean }]>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error(`unstubbed fetch: ${url}`);
    const [, res] = hit;
    if (res.throws) throw new TypeError('Failed to fetch');
    return {
      ok: (res.status ?? 200) >= 200 && (res.status ?? 200) < 300,
      status: res.status ?? 200,
      text: async () => res.body ?? '',
    } as Response;
  }) as typeof fetch;
}

const LIVE_MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg1.ts\n#EXTINF:10.0,\nseg2.ts\n';

describe('probeFeed', () => {
  test('accepts a live media playlist whose segments are reachable', async () => {
    serve([['playlist.m3u8', { body: LIVE_MEDIA }], ['seg', { status: 206 }]]);
    const r = await probeFeed('https://x.test/playlist.m3u8');
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('live');
  });

  test('rejects VOD — it cannot go stale, so the watchdog has nothing to watch', async () => {
    serve([['playlist.m3u8', { body: `${LIVE_MEDIA}#EXT-X-ENDLIST\n` }]]);
    const r = await probeFeed('https://x.test/playlist.m3u8');
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('vod');
  });

  test('rejects a non-HLS body even when it returns 200', async () => {
    serve([['playlist.m3u8', { body: '<!doctype html><title>login</title>' }]]);
    expect((await probeFeed('https://x.test/playlist.m3u8')).verdict).toBe('not-hls');
  });

  test('reports a blocked request as CORS rather than a generic failure', async () => {
    serve([['playlist.m3u8', { throws: true }]]);
    const r = await probeFeed('https://x.test/playlist.m3u8');
    expect(r.verdict).toBe('cors');
    expect(r.ok).toBe(false);
  });

  test('surfaces an HTTP error status', async () => {
    serve([['playlist.m3u8', { status: 403 }]]);
    const r = await probeFeed('https://x.test/playlist.m3u8');
    expect(r.verdict).toBe('http');
    expect(r.detail).toContain('403');
  });

  test('follows a master to its variant and judges the variant', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunklist.m3u8\n';
    serve([
      ['master.m3u8', { body: master }],
      ['chunklist.m3u8', { body: LIVE_MEDIA }],
      ['seg', { status: 206 }],
    ]);
    expect((await probeFeed('https://x.test/master.m3u8')).verdict).toBe('live');
  });

  test('catches a master advertising a variant that 404s', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunklist.m3u8\n';
    serve([['master.m3u8', { body: master }], ['chunklist.m3u8', { status: 404 }]]);
    const r = await probeFeed('https://x.test/master.m3u8');
    expect(r.verdict).toBe('http');
    expect(r.ok).toBe(false);
  });

  /**
   * The one a naive check misses: the playlist is fine and the media is not.
   * This passes every header inspection and then fails the moment it plays.
   */
  test('catches a playlist that is CORS-clean while its segments are not', async () => {
    serve([['playlist.m3u8', { body: LIVE_MEDIA }], ['seg', { throws: true }]]);
    const r = await probeFeed('https://x.test/playlist.m3u8');
    expect(r.verdict).toBe('cors');
    expect(r.detail).toContain('SEGMENTS');
  });
});

describe('loadRegistry', () => {
  const KEY = 'liveview-watchdog:registry:v3';
  afterEach(() => localStorage.removeItem(KEY));

  test('falls back to defaults when storage is empty', () => {
    expect(loadRegistry()).toEqual(DEFAULT_REGISTRY);
  });

  test('falls back rather than throwing on corrupt JSON', () => {
    localStorage.setItem(KEY, '{not json');
    expect(loadRegistry()).toEqual(DEFAULT_REGISTRY);
  });

  test('falls back when the stored shape is wrong', () => {
    localStorage.setItem(KEY, JSON.stringify({ groups: 'nope', feeds: [] }));
    expect(loadRegistry()).toEqual(DEFAULT_REGISTRY);
  });

  test('falls back when every group has been removed, rather than showing an empty wall', () => {
    localStorage.setItem(KEY, JSON.stringify({ groups: [], feeds: [] }));
    expect(loadRegistry()).toEqual(DEFAULT_REGISTRY);
  });

  test('returns a stored registry intact', () => {
    const mine = { groups: [{ id: 'g1', name: 'Mine' }], feeds: [] };
    localStorage.setItem(KEY, JSON.stringify(mine));
    expect(loadRegistry()).toEqual(mine);
  });
});
