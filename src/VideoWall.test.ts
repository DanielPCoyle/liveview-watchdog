/**
 * Geometry checks for the wall layout. Run with `bun test` — no framework, no
 * config, nothing added to package.json.
 *
 * `emphasize` is the only piece here that can be wrong *invisibly*: a hover
 * that pushes a tile half off the viewport still animates smoothly and still
 * looks deliberate, so a bad clamp survives a manual look at the app.
 */
import { expect, test } from 'bun:test';
import { computeLayout, emphasize, EMPHASIS, VW, VH } from './VideoWall';

const inside = (b: { x: number; y: number; w: number; h: number }) =>
  b.x - b.w / 2 >= -0.001 && b.x + b.w / 2 <= VW + 0.001 &&
  b.y - b.h / 2 >= -0.001 && b.y + b.h / 2 <= VH + 0.001;

test('emphasize grows the named tile and leaves the rest alone', () => {
  const base = computeLayout(['a', 'b', 'c', 'd'], []);
  const out = emphasize(base, 'b');
  expect(out.get('b')!.w).toBeCloseTo(base.get('b')!.w * EMPHASIS);
  expect(out.get('b')!.h).toBeCloseTo(base.get('b')!.h * EMPHASIS);
  for (const id of ['a', 'c', 'd']) expect(out.get(id)).toEqual(base.get(id));
});

test('an emphasized tile stays inside the viewport, wherever it sits', () => {
  // Carousel tiles hug the bottom edge and the corners of the grid hug two
  // edges each; every one of them has to survive being swollen.
  for (const heroes of [[] as string[], ['a']]) {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const base = computeLayout(ids, heroes);
    for (const id of ids) {
      const box = emphasize(base, id).get(id)!;
      expect(inside(box)).toBe(true);
    }
  }
});

test('emphasize on an unknown id is a no-op', () => {
  const base = computeLayout(['a'], []);
  expect(emphasize(base, 'nope')).toBe(base);
});
