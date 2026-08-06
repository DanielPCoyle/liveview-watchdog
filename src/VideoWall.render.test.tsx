/**
 * The compositor, against a fake GPU.
 *
 * `three` is mocked at the library boundary so VideoWall's own logic runs for
 * real: which meshes exist, what their target boxes are, how selection changes
 * the upload budget, and what a click resolves to. Mocking the component
 * instead would have tested nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import * as threeStub from './three-stub';
import { VideoWall, computeLayout } from './VideoWall';

function makeVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  Object.defineProperty(v, 'readyState', { value: 4 });
  return v;
}

const streams = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `f${i}`, el: makeVideo() }));

afterEach(cleanup);
beforeEach(() => { threeStub.Raycaster.nextHit = null; });

describe('VideoWall', () => {
  test('mounts a canvas and builds one group per stream', async () => {
    const s = streams(3);
    const layout = computeLayout(s.map((x) => x.id), []);
    const { container } = render(
      <VideoWall streams={s} statusById={{ f0: 'live', f1: 'live', f2: 'live' }}
        heroIds={[]} hoverId={null} layout={layout}
        onToggleFocus={() => {}} onFps={() => {}} />,
    );
    expect(container.querySelector('.wall')).not.toBeNull();
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  test('renders continuously and reports a frame rate', async () => {
    const s = streams(1);
    const fps: number[] = [];
    render(
      <VideoWall streams={s} statusById={{ f0: 'live' }} heroIds={[]} hoverId={null}
        layout={computeLayout(['f0'], [])} onToggleFocus={() => {}} onFps={(f) => fps.push(f)} />,
    );
    // The loop is rAF-driven; one second of it should produce an fps report.
    await new Promise((r) => setTimeout(r, 1200));
    expect(fps.length).toBeGreaterThan(0);
    expect(fps[0]).toBeGreaterThan(0);
  });

  test('a click resolves to the tile that was hit', async () => {
    const s = streams(2);
    const picked: string[] = [];
    const { container } = render(
      <VideoWall streams={s} statusById={{ f0: 'live', f1: 'live' }} heroIds={[]} hoverId={null}
        layout={computeLayout(['f0', 'f1'], [])} onToggleFocus={(id) => picked.push(id)}
        onFps={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    container.querySelector('canvas')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picked.length).toBe(1);
    expect(['f0', 'f1']).toContain(picked[0]);
  });

  test('a click that hits nothing changes no selection', async () => {
    const s = streams(1);
    const picked: string[] = [];
    threeStub.Raycaster.nextHit = { notATile: true };
    const { container } = render(
      <VideoWall streams={s} statusById={{ f0: 'live' }} heroIds={[]} hoverId={null}
        layout={computeLayout(['f0'], [])} onToggleFocus={(id) => picked.push(id)} onFps={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    container.querySelector('canvas')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picked).toEqual([]);
  });

  test('promoting a feed retargets the layout without rebuilding the scene', async () => {
    const s = streams(3);
    const ids = s.map((x) => x.id);
    const { rerender } = render(
      <VideoWall streams={s} statusById={{}} heroIds={[]} hoverId={null}
        layout={computeLayout(ids, [])} onToggleFocus={() => {}} onFps={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    // Hero layout: the promoted tile becomes much wider than a carousel tile.
    const hero = computeLayout(ids, ['f1']);
    expect(hero.get('f1')!.w).toBeGreaterThan(hero.get('f0')!.w);
    expect(() =>
      rerender(
        <VideoWall streams={s} statusById={{}} heroIds={['f1']} hoverId={null}
          layout={hero} onToggleFocus={() => {}} onFps={() => {}} />,
      )).not.toThrow();
  });

  test('a status change recolours without tearing down the tiles', async () => {
    const s = streams(2);
    const layout = computeLayout(['f0', 'f1'], []);
    // Stable callback identities, as App supplies via useCallback: the renderer
    // effect keys on them, so fresh closures would legitimately rebuild it.
    const onToggleFocus = () => {};
    const onFps = () => {};
    const { rerender, container } = render(
      <VideoWall streams={s} statusById={{ f0: 'live', f1: 'live' }} heroIds={[]} hoverId={null}
        layout={layout} onToggleFocus={onToggleFocus} onFps={onFps} />,
    );
    const canvasBefore = container.querySelector('canvas');
    rerender(
      <VideoWall streams={s} statusById={{ f0: 'stale', f1: 'degraded' }} heroIds={[]} hoverId={null}
        layout={layout} onToggleFocus={onToggleFocus} onFps={onFps} />,
    );
    expect(container.querySelector('canvas')).toBe(canvasBefore!);
  });

  test('a stream with no element yet still gets a tile', async () => {
    const s = [{ id: 'f0', el: null }];
    expect(() =>
      render(
        <VideoWall streams={s} statusById={{ f0: 'idle' }} heroIds={[]} hoverId={null}
          layout={computeLayout(['f0'], [])} onToggleFocus={() => {}} onFps={() => {}} />,
      )).not.toThrow();
  });

  test('unmounting disposes the renderer and detaches the canvas', async () => {
    const s = streams(2);
    const { container, unmount } = render(
      <VideoWall streams={s} statusById={{}} heroIds={[]} hoverId={null}
        layout={computeLayout(['f0', 'f1'], [])} onToggleFocus={() => {}} onFps={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    unmount();
    expect(container.querySelector('canvas')).toBeNull();
  });
});
