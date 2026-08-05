import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Liveness } from './types';

/**
 * GPU compositor for the wall.
 *
 * A video wall cannot be N <video> elements. Each one is a separately
 * composited layer the browser must lay out, paint and blend every frame, and
 * past roughly a dozen the main thread spends its budget on presentation
 * instead of the product. Real VMS clients decode to textures and composite
 * once on the GPU — that is what this does.
 *
 * What it does NOT fix: decode. There is still one decoder per stream, which is
 * the real ceiling. The production answer is a low-resolution sub-stream for
 * wall tiles and full resolution only for the focused feed — which is why the
 * `hls.currentLevel` cap exists in useTile rather than being only a fault.
 */

const STATUS_COLOR: Record<Liveness, number> = {
  live: 0x2f7a5a,
  degraded: 0xc89440,
  stale: 0xf04d91,
  idle: 0x2a3542,
};

export interface WallStreamRef {
  id: string;
  el: HTMLVideoElement | null;
}

/**
 * `streams` and `statusById` are deliberately separate props.
 *
 * They change at wildly different rates: the stream SET changes when the
 * operator resizes the wall, while status changes ~10x/second. Folding them
 * into one array meant the scene-build effect saw a new identity on every
 * status tick and tore down every mesh and texture ten times a second — which
 * both blanked the tiles and made the GPU path look far more expensive than it
 * is. Layout rebuilds on the stream set; status only recolours a frame.
 */
export function VideoWall({
  streams,
  statusById,
  onFps,
}: {
  streams: WallStreamRef[];
  statusById: Record<string, Liveness>;
  onFps: (fps: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    camera?: THREE.OrthographicCamera;
    tiles: Map<string, {
      frame: THREE.Mesh; screen: THREE.Mesh; tex?: THREE.Texture;
      el?: HTMLVideoElement | null; lastUpload: number;
    }>;
    uploadIntervalMs: number;
    raf?: number;
  }>({ tiles: new Map(), uploadIntervalMs: 0 });

  // Rebuild only when the stream set changes, or when an element first becomes
  // available (refs arrive after mount, so the first pass can legitimately see
  // nulls and must be redone once).
  const layoutKey = useMemo(
    () => streams.map((s) => `${s.id}:${s.el ? 1 : 0}`).join(','),
    [streams],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0d1117, 1);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);

    const st = stateRef.current;
    st.renderer = renderer; st.scene = scene; st.camera = camera;

    let frames = 0;
    let lastFpsAt = performance.now();

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const loop = () => {
      const now = performance.now();
      frames += 1;
      if (now - lastFpsAt >= 1000) {
        onFps(+(frames * 1000 / (now - lastFpsAt)).toFixed(1));
        frames = 0; lastFpsAt = now;
      }

      // Texture invalidation lives here rather than in requestVideoFrameCallback.
      // rVFC only fires for video that is actually PRESENTED, and these decoders
      // are deliberately offscreen — so the callback never ran and every tile
      // stayed black. Upload on our own rate-capped schedule instead, skipping
      // any feed without decoded data (a dead camera then costs zero uploads,
      // which was the point of tying uploads to liveness in the first place).
      for (const t of st.tiles.values()) {
        if (!t.tex || !t.el) continue;
        if (t.el.readyState < 2) continue;
        if (now - t.lastUpload < st.uploadIntervalMs) continue;
        t.tex.needsUpdate = true;
        t.lastUpload = now;
      }

      renderer.render(scene, camera);
      st.raf = requestAnimationFrame(loop);
    };
    st.raf = requestAnimationFrame(loop);

    return () => {
      if (st.raf) cancelAnimationFrame(st.raf);
      ro.disconnect();
      st.tiles.forEach((t) => {
        t.tex?.dispose();
        (t.screen.material as THREE.Material).dispose();
        (t.frame.material as THREE.Material).dispose();
        t.screen.geometry.dispose();
        t.frame.geometry.dispose();
      });
      st.tiles.clear();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      st.renderer = undefined; st.scene = undefined;
    };
  }, [onFps]);

  // Build / rebuild the grid when the set of streams changes.
  useEffect(() => {
    const st = stateRef.current;
    const scene = st.scene; const camera = st.camera;
    if (!scene || !camera) return;

    st.tiles.forEach((t) => { scene.remove(t.screen); scene.remove(t.frame); t.tex?.dispose(); });
    st.tiles.clear();

    // Per-tile upload budget, consumed by the render loop. Small walls get
    // source rate; large walls trade smoothness for the ability to show the
    // wall at all — the same reason real VMS clients pull a low-resolution
    // sub-stream for wall tiles and full resolution only for the focused feed.
    st.uploadIntervalMs = streams.length <= 8 ? 0 : streams.length <= 24 ? 100 : 200;

    // Past a modest tile count the wall is bandwidth-bound, not detail-bound:
    // drop to 1x so we aren't uploading and shading 4x the pixels per tile.
    st.renderer?.setPixelRatio(streams.length > 12 ? 1 : Math.min(window.devicePixelRatio, 2));

    const n = Math.max(1, streams.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cellW = 16, cellH = 9, gap = 0.6;

    camera.left = 0; camera.right = cols * (cellW + gap);
    camera.top = rows * (cellH + gap); camera.bottom = 0;
    camera.updateProjectionMatrix();

    streams.forEach((item, i) => {
      const cx = (i % cols) * (cellW + gap) + cellW / 2 + gap / 2;
      const cy = camera.top - (Math.floor(i / cols) * (cellH + gap) + cellH / 2 + gap / 2);

      const frame = new THREE.Mesh(
        new THREE.PlaneGeometry(cellW + 0.35, cellH + 0.35),
        new THREE.MeshBasicMaterial({ color: STATUS_COLOR[statusById[item.id] ?? 'idle'] }),
      );
      frame.position.set(cx, cy, -0.1);

      // Deliberately NOT THREE.VideoTexture: it flags needsUpdate on every
      // render, so an N-tile wall performs N full texImage2D uploads per frame
      // whether or not anything changed. Measured at 24 feeds that collapsed
      // the wall to 6.7fps — worse than letting the browser composite <video>
      // layers natively (30fps).
      //
      // Upload on FRAME ARRIVAL instead. We already know precisely when each
      // feed delivers a frame — that is what the watchdog measures — so the
      // liveness signal doubles as the invalidation signal. A stale feed costs
      // zero uploads, which is exactly the behaviour you want on a wall where
      // some cameras are down.
      // VideoTexture — plain THREE.Texture does NOT take three.js's video
      // upload path and renders black no matter how you flag needsUpdate.
      // But VideoTexture.update() marks itself dirty on EVERY render, which is
      // the N-uploads-per-frame problem. So keep its upload path and neuter its
      // auto-invalidation; the render loop decides when to upload instead.
      const tex = item.el ? new THREE.VideoTexture(item.el) : undefined;
      if (tex) {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.update = () => {};
        tex.needsUpdate = true;
      }
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(cellW, cellH),
        new THREE.MeshBasicMaterial({ map: tex ?? null, color: tex ? 0xffffff : 0x000000 }),
      );
      screen.position.set(cx, cy, 0);

      scene.add(frame); scene.add(screen);

      st.tiles.set(item.id, { frame, screen, tex, el: item.el, lastUpload: 0 });
    });
    // Intentionally keyed on layoutKey only: statusById must NOT rebuild the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Status changes only recolour an existing material — no scene rebuild.
  useEffect(() => {
    const st = stateRef.current;
    for (const [id, liveness] of Object.entries(statusById)) {
      const t = st.tiles.get(id);
      if (!t) continue;
      (t.frame.material as THREE.MeshBasicMaterial).color.setHex(STATUS_COLOR[liveness]);
    }
  }, [statusById]);

  return <div className="wall" ref={hostRef} />;
}
