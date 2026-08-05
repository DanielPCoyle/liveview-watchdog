import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Liveness } from './types';

/**
 * GPU compositor for the wall.
 *
 * A video wall cannot be N <video> elements: each is a separately composited
 * layer the browser lays out, paints and blends every frame. This draws every
 * feed as a textured quad in one WebGL surface instead.
 *
 * It does NOT fix decode — there is still one decoder per stream, which is the
 * real ceiling. The production answer is a low-resolution sub-stream for wall
 * tiles and full resolution only for the focused feed. Selecting a feed here
 * drives exactly that policy: the focused tile uploads every frame, the strip
 * is rate-capped.
 *
 * See README for the compositor benchmark I had to throw away.
 */

const STATUS_COLOR: Record<Liveness, number> = {
  live: 0x2f7a5a,
  degraded: 0xc89440,
  stale: 0xf04d91,
  idle: 0x2a3542,
};

export const VW = 160;              // virtual viewport units (16:9)
export const VH = 90;
const STRIP_H = VH * 0.20;         // carousel of everything not promoted

export interface WallStreamRef {
  id: string;
  el: HTMLVideoElement | null;
}

export interface Box { x: number; y: number; w: number; h: number }

/**
 * Target geometry per tile: a plain grid, or a hero band plus a carousel when
 * one or more feeds are promoted.
 *
 * Heroes are a SET, not a single id — an alarm state can involve several
 * cameras at once, and an operator handling a multi-camera incident should not
 * have to click between them.
 */
export function computeLayout(ids: string[], heroIds: string[]): Map<string, Box> {
  const out = new Map<string, Box>();
  const heroes = heroIds.filter((id) => ids.includes(id));
  const gap = 1.2;

  if (heroes.length === 0) {
    const n = Math.max(1, ids.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = (VW - gap * (cols + 1)) / cols;
    const ch = (VH - gap * (rows + 1)) / rows;
    ids.forEach((id, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      out.set(id, {
        x: gap + c * (cw + gap) + cw / 2,
        y: VH - (gap + r * (ch + gap) + ch / 2),
        w: cw, h: ch,
      });
    });
    return out;
  }

  const others = ids.filter((id) => !heroes.includes(id));
  const bandBottom = others.length ? STRIP_H + 1 : 2;
  const bandTop = VH - 2;
  const bandH = bandTop - bandBottom;

  // Tile the heroes inside the band, each keeping 16:9.
  const k = heroes.length;
  const cols = Math.ceil(Math.sqrt(k));
  const rows = Math.ceil(k / cols);
  const cellW = (VW - 6 - gap * (cols - 1)) / cols;
  const cellH = (bandH - gap * (rows - 1)) / rows;
  const w = Math.min(cellW, cellH * (16 / 9));
  const h = w / (16 / 9);
  const gridW = cols * w + gap * (cols - 1);
  const gridH = rows * h + gap * (rows - 1);
  const originX = (VW - gridW) / 2 + w / 2;
  const originY = bandTop - (bandH - gridH) / 2 - h / 2;

  heroes.forEach((id, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    out.set(id, { x: originX + c * (w + gap), y: originY - r * (h + gap), w, h });
  });

  if (others.length) {
    let th = STRIP_H - 2;
    let tw = th * (16 / 9);
    const totalW = others.length * tw + gap * (others.length - 1);
    if (totalW > VW - 4) {                       // compress to fit
      const scale = (VW - 4) / totalW;
      tw *= scale; th *= scale;
    }
    const width = others.length * tw + gap * (others.length - 1);
    const startX = (VW - width) / 2 + tw / 2;
    others.forEach((id, i) => {
      out.set(id, { x: startX + i * (tw + gap), y: STRIP_H / 2, w: tw, h: th });
    });
  }
  return out;
}

export function VideoWall({
  streams,
  statusById,
  heroIds,
  layout,
  onToggleFocus,
  onFps,
}: {
  streams: WallStreamRef[];
  statusById: Record<string, Liveness>;
  heroIds: string[];
  /**
   * Layout is computed by the caller and passed in, not derived here. The wall
   * is no longer the only thing on the grid — there is an empty "add feed"
   * slot too — so a single source of truth beats two implementations that have
   * to agree.
   */
  layout: Map<string, Box>;
  onToggleFocus: (id: string) => void;
  onFps: (fps: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const st = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    camera?: THREE.OrthographicCamera;
    tiles: Map<string, {
      group: THREE.Group; frame: THREE.Mesh; screen: THREE.Mesh;
      tex?: THREE.Texture; el?: HTMLVideoElement | null;
      lastUpload: number; target: Box; current: Box;
    }>;
    layout: Map<string, Box>;
    heroIds: string[];
    uploadIntervalMs: number;
    raf?: number;
  }>({ tiles: new Map(), layout: new Map(), heroIds: [], uploadIntervalMs: 0 });

  const layoutKey = useMemo(
    () => streams.map((s) => `${s.id}:${s.el ? 1 : 0}`).join(','),
    [streams],
  );
  const heroKey = heroIds.join(',');
  const layoutKeyIds = [...layout.keys()].join(',');

  // ── renderer + animation loop ────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0x0a0e14, 1);
    host.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, VW, VH, 0, -10, 10);
    const s = st.current;
    s.renderer = renderer; s.scene = scene; s.camera = camera;

    let frames = 0, lastFpsAt = performance.now();
    const resize = () => renderer.setSize(host.clientWidth || 1, host.clientHeight || 1, false);
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

      for (const [id, t] of s.tiles) {
        // Ease toward the target box — this is the carousel transition.
        const k = 0.18;
        t.current.x += (t.target.x - t.current.x) * k;
        t.current.y += (t.target.y - t.current.y) * k;
        t.current.w += (t.target.w - t.current.w) * k;
        t.current.h += (t.target.h - t.current.h) * k;
        t.group.position.set(t.current.x, t.current.y, s.heroIds.includes(id) ? 1 : 0);
        t.screen.scale.set(t.current.w, t.current.h, 1);
        t.frame.scale.set(t.current.w + 0.5, t.current.h + 0.5, 1);

        // Upload policy follows selection: focused feed every frame, the rest
        // rate-capped. This is the whole point of having a focused view.
        if (t.tex && t.el && t.el.readyState >= 2) {
          const budget = s.heroIds.includes(id) ? 0 : s.uploadIntervalMs;
          if (now - t.lastUpload >= budget) { t.tex.needsUpdate = true; t.lastUpload = now; }
        }
      }

      renderer.render(scene, camera);
      s.raf = requestAnimationFrame(loop);
    };
    s.raf = requestAnimationFrame(loop);

    // ── click to focus (raycast into the scene) ────────────────────────────
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onClick = (ev: MouseEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const meshes = [...s.tiles.values()].map((t) => t.screen);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit) return;
      for (const [id, t] of s.tiles) if (t.screen === hit.object) { onToggleFocus(id); return; }
    };
    renderer.domElement.addEventListener('click', onClick);

    return () => {
      if (s.raf) cancelAnimationFrame(s.raf);
      renderer.domElement.removeEventListener('click', onClick);
      ro.disconnect();
      s.tiles.forEach((t) => {
        t.tex?.dispose();
        (t.screen.material as THREE.Material).dispose();
        (t.frame.material as THREE.Material).dispose();
        t.screen.geometry.dispose(); t.frame.geometry.dispose();
      });
      s.tiles.clear();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      s.renderer = undefined; s.scene = undefined;
    };
  }, [onFps, onToggleFocus]);

  // ── build meshes when the stream set changes ─────────────────────────────
  useEffect(() => {
    const s = st.current;
    const scene = s.scene;
    if (!scene) return;

    s.tiles.forEach((t) => { scene.remove(t.group); t.tex?.dispose(); });
    s.tiles.clear();

    s.uploadIntervalMs = streams.length <= 8 ? 0 : streams.length <= 24 ? 100 : 200;
    s.renderer?.setPixelRatio(streams.length > 12 ? 1 : Math.min(window.devicePixelRatio, 2));

    s.layout = layout;

    streams.forEach((item) => {
      const box = layout.get(item.id) ?? { x: VW / 2, y: VH / 2, w: 10, h: 6 };
      const group = new THREE.Group();

      const frame = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ color: STATUS_COLOR[statusById[item.id] ?? 'idle'] }),
      );
      frame.position.z = -0.05;

      // VideoTexture: plain THREE.Texture does not take three.js's video upload
      // path and renders black. Keep its upload path, neuter its per-render
      // auto-invalidation, and let the render loop own the rate.
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
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: tex ?? null, color: tex ? 0xffffff : 0x000000 }),
      );

      group.add(frame); group.add(screen);
      group.position.set(box.x, box.y, 0);
      scene.add(group);

      s.tiles.set(item.id, {
        group, frame, screen, tex, el: item.el, lastUpload: 0,
        target: { ...box }, current: { ...box },
      });
    });
    // Status must not rebuild the scene — see README.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // ── focus change: retarget boxes, let the loop animate ──────────────────
  useEffect(() => {
    const s = st.current;
    s.heroIds = heroIds;
    s.layout = layout;
    for (const [id, t] of s.tiles) {
      const box = layout.get(id);
      if (box) t.target = { ...box };
    }
  }, [heroKey, layoutKey, layoutKeyIds, layout, heroIds]);

  // ── status: recolour only ───────────────────────────────────────────────
  useEffect(() => {
    for (const [id, liveness] of Object.entries(statusById)) {
      const t = st.current.tiles.get(id);
      if (t) (t.frame.material as THREE.MeshBasicMaterial).color.setHex(STATUS_COLOR[liveness]);
    }
  }, [statusById]);

  return <div className="wall" ref={hostRef} />;
}
