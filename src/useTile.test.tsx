/**
 * One decoder's lifecycle, with hls.js mocked at the library boundary.
 *
 * The interesting behaviour here is not playback — it is the policy around it:
 * buffer headroom derived from the stream's own segment duration, a bounded
 * recovery ladder, and the rule that a deliberately frozen feed must never be
 * silently revived. Each of those is a decision that would be invisible if it
 * regressed.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';

/** A stand-in for hls.js that records what the code under test asked of it. */
class FakeHls {
  static instances: FakeHls[] = [];
  static isSupported = () => true;
  static Events = {
    MANIFEST_PARSED: 'manifestParsed', LEVEL_LOADED: 'levelLoaded', ERROR: 'error',
  };
  static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' };

  config: Record<string, unknown>;
  handlers: Record<string, (e: string, d: unknown) => void> = {};
  currentLevel = -1;
  calls: string[] = [];
  destroyed = false;

  constructor(cfg: Record<string, unknown>) {
    this.config = { ...cfg };
    FakeHls.instances.push(this);
  }
  on(evt: string, fn: (e: string, d: unknown) => void) { this.handlers[evt] = fn; }
  loadSource(src: string) { this.calls.push(`loadSource:${src}`); }
  attachMedia() { this.calls.push('attachMedia'); }
  startLoad() { this.calls.push('startLoad'); }
  stopLoad() { this.calls.push('stopLoad'); }
  recoverMediaError() { this.calls.push('recoverMediaError'); }
  destroy() { this.destroyed = true; this.calls.push('destroy'); }
  /** Test helper: raise an event as hls.js would. */
  fire(evt: string, data: unknown) { this.handlers[evt]?.(evt, data); }
}

mock.module('hls.js', () => ({ default: FakeHls }));

const { useTile } = await import('./useTile');

/** Mounts a tile and returns its hls instance plus the element. */
function mountTile(props: Partial<Parameters<typeof useTile>[0]> = {}) {
  const args = {
    id: 't1', src: 'https://example.test/live.m3u8', fault: 'none' as const,
    onFrame: () => {}, onIdle: () => {}, ...props,
  };
  let api: ReturnType<typeof useTile> | null = null;
  function Tile(p: typeof args) {
    api = useTile(p);
    return <video ref={api.attachRef} />;
  }
  const view = render(<Tile {...args} />);
  return { view, get hls() { return FakeHls.instances.at(-1)!; }, get api() { return api!; } };
}

beforeEach(() => { FakeHls.instances = []; });
afterEach(cleanup);

describe('useTile with a real transport', () => {
  test('attaches hls to the element and loads the source', async () => {
    const t = mountTile();
    await waitFor(() => expect(FakeHls.instances.length).toBe(1));
    expect(t.hls.calls).toContain('loadSource:https://example.test/live.m3u8');
    expect(t.hls.calls).toContain('attachMedia');
  });

  test('starts with the aggressive live-edge buffer', async () => {
    const t = mountTile();
    await waitFor(() => expect(FakeHls.instances.length).toBe(1));
    expect(t.hls.config.maxBufferLength).toBe(3);
  });

  /**
   * The bug this encodes: 3 seconds is three segments on a 1s feed and less
   * than one on a 10s traffic camera, which parks the player at the live edge
   * and manufactures outages the camera never had.
   */
  test('raises buffer headroom to two segments once the stream declares its duration', async () => {
    const t = mountTile();
    await waitFor(() => expect(FakeHls.instances.length).toBe(1));
    t.hls.fire('levelLoaded', { details: { targetduration: 10 } });
    expect(t.hls.config.maxBufferLength).toBe(20);
  });

  test('never drops headroom below the floor for a short-segment feed', async () => {
    const t = mountTile();
    await waitFor(() => expect(FakeHls.instances.length).toBe(1));
    t.hls.fire('levelLoaded', { details: { targetduration: 1 } });
    expect(t.hls.config.maxBufferLength).toBe(3);
  });

  test('a non-fatal error is left alone', async () => {
    const t = mountTile();
    await waitFor(() => expect(FakeHls.instances.length).toBe(1));
    t.hls.calls.length = 0;
    t.hls.fire('error', { fatal: false, type: FakeHls.ErrorTypes.NETWORK_ERROR });
    expect(t.hls.calls).toEqual([]);
  });

  test('a fatal network error is retried, but only a bounded number of times', async () => {
    const t = mountTile();
    await waitFor(() => expect(FakeHls.instances.length).toBe(1));
    t.hls.calls.length = 0;
    for (let i = 0; i < 6; i++) {
      t.hls.fire('error', { fatal: true, type: FakeHls.ErrorTypes.NETWORK_ERROR, details: 'x' });
    }
    // Three attempts, then it stops rather than spinning forever on a dead origin.
    expect(t.hls.calls.filter((c) => c === 'startLoad').length).toBe(3);
  });

  test('a fatal media error takes the recover path', async () => {
    const t = mountTile();
    await waitFor(() => expect(FakeHls.instances.length).toBe(1));
    t.hls.calls.length = 0;
    t.hls.fire('error', { fatal: true, type: FakeHls.ErrorTypes.MEDIA_ERROR, details: 'x' });
    expect(t.hls.calls).toContain('recoverMediaError');
  });

  /**
   * `freeze` IS a stopLoad, which surfaces as a fatal network error seconds
   * later. Recovering it would silently undo the fault the operator injected.
   */
  test('a deliberately frozen feed is never auto-recovered', async () => {
    const t = mountTile({ fault: 'freeze' });
    await waitFor(() => expect(FakeHls.instances.length).toBe(1));
    await waitFor(() => expect(t.hls.calls).toContain('stopLoad'));
    t.hls.calls.length = 0;
    t.hls.fire('error', { fatal: true, type: FakeHls.ErrorTypes.NETWORK_ERROR, details: 'x' });
    expect(t.hls.calls).not.toContain('startLoad');
  });

  test('low-quality pins the lowest rendition', async () => {
    const t = mountTile({ fault: 'lowQuality' });
    await waitFor(() => expect(t.hls.currentLevel).toBe(0));
  });

  test('selection drives quality: focused asks for full, the rest pin low', async () => {
    const t = mountTile({ focused: true });
    await waitFor(() => expect(FakeHls.instances.length).toBe(1));
    expect(t.hls.currentLevel).toBe(-1);

    const u = mountTile({ focused: false });
    await waitFor(() => expect(FakeHls.instances.length).toBe(2));
    expect(u.hls.currentLevel).toBe(0);
  });

  test('unmounting destroys the decoder and reports the feed idle', async () => {
    let idled = '';
    const t = mountTile({ onIdle: (id: string) => { idled = id; } });
    await waitFor(() => expect(FakeHls.instances.length).toBe(1));
    t.view.unmount();
    expect(t.hls.destroyed).toBe(true);
    expect(idled).toBe('t1');
  });
});

describe('useTile with a mock source', () => {
  test('emits a frame heartbeat without any transport at all', async () => {
    const frames: Array<{ at: number; media: number }> = [];
    mountTile({ src: 'mock:cam9', onFrame: (_id: string, at: number, media: number) => frames.push({ at, media }) });
    await waitFor(() => expect(frames.length).toBeGreaterThan(2), { timeout: 2000 });
    // No hls instance was created for a mock source.
    expect(FakeHls.instances.length).toBe(0);
    // And the media clock advances with wall clock.
    expect(frames.at(-1)!.media).toBeGreaterThan(0);
  });

  /**
   * The claim the project is named for: a frozen feed keeps DELIVERING frames
   * and stops advancing its clock. Stopping the heartbeat would be the easy
   * case, and would test the wrong thing.
   */
  test('a frozen mock keeps delivering frames while its media clock stands still', async () => {
    const frames: Array<{ media: number }> = [];
    mountTile({ src: 'mock:cam9', fault: 'freeze', onFrame: (_i: string, _a: number, media: number) => frames.push({ media }) });
    await waitFor(() => expect(frames.length).toBeGreaterThan(3), { timeout: 2000 });
    const media = frames.map((f) => f.media);
    expect(media.every((m) => m === media[0])).toBe(true);
  });
});
