/**
 * Wall geometry. Deliberately free of any three.js import.
 *
 * The compositor is ~600kb of GPU library that a narrow viewport never mounts,
 * so it is loaded on demand — but the layout maths it operates on are needed
 * immediately, by the DOM overlays and by the roster's hover emphasis. Keeping
 * them in the same module as the renderer meant asking for a rectangle and
 * getting WebGL with it.
 */

export interface Box { x: number; y: number; w: number; h: number }

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

/** How much a hovered tile swells. Enough to find by eye, not enough to be a
 *  layout change — pointing at a row should preview, not navigate. */
export const EMPHASIS = 1.16;

/**
 * Swell one tile in place.
 *
 * Hover feedback goes through the LAYOUT rather than a CSS class on the overlay
 * because the picture is WebGL: the chrome is a DOM box tracking a quad, and
 * scaling only the DOM half would slide the label off the video it belongs to.
 * Retarget the box and both halves follow — the render loop's lerp and the
 * overlay's transition already animate everything else.
 */
export function emphasize(layout: Map<string, Box>, id: string, scale = EMPHASIS): Map<string, Box> {
  const box = layout.get(id);
  if (!box) return layout;
  const w = box.w * scale;
  const h = box.h * scale;
  // Nudge back inside the viewport. Carousel tiles sit at the very edge, and a
  // tile that grows half off-screen reads as a glitch rather than as a cue.
  const out = new Map(layout);
  out.set(id, {
    x: Math.min(Math.max(box.x, w / 2), VW - w / 2),
    y: Math.min(Math.max(box.y, h / 2), VH - h / 2),
    w, h,
  });
  return out;
}
