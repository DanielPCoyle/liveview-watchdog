/**
 * A minimal stand-in for three.js.
 *
 * Mocked at the library boundary rather than mocking VideoWall itself, so the
 * compositor's own logic — layout maths, mesh lifecycle, the upload budget,
 * raycast hit-testing — runs for real against a fake GPU. Mocking the component
 * would have covered none of it.
 */
class V3 {
  x = 0; y = 0; z = 0;
  set(x: number, y: number, z = 0) { this.x = x; this.y = y; this.z = z; return this; }
}
class Col {
  hex = 0xffffff;
  setHex(h: number) { this.hex = h; return this; }
}
export class Vector2 { x = 0; y = 0; }
export class Group {
  children: unknown[] = []; position = new V3();
  add(o: unknown) { this.children.push(o); }
}
export class Mesh {
  position = new V3(); scale = new V3();
  constructor(public geometry: unknown, public material: unknown) {}
}
export class PlaneGeometry { dispose() {} }
export class MeshBasicMaterial {
  color = new Col();
  constructor(public opts: Record<string, unknown> = {}) {}
  dispose() {}
}
export class VideoTexture {
  colorSpace = ''; minFilter = 0; magFilter = 0; generateMipmaps = true; needsUpdate = false;
  constructor(public el: unknown) {}
  update() {} dispose() {}
}
export class Scene {
  children: unknown[] = [];
  add(o: unknown) { this.children.push(o); }
  remove(o: unknown) { this.children = this.children.filter((c) => c !== o); }
}
export class OrthographicCamera { constructor(..._a: number[]) {} }
export class WebGLRenderer {
  domElement = document.createElement('canvas');
  renders = 0;
  constructor(public opts: Record<string, unknown> = {}) {}
  setClearColor() {} setSize() {} setPixelRatio() {}
  render() { this.renders += 1; }
  dispose() {}
}
export class Raycaster {
  /** Hit-testing is driven by the test, not by real geometry. */
  static nextHit: unknown = null;
  setFromCamera() {}
  intersectObjects(objs: unknown[]) {
    const hit = Raycaster.nextHit ?? objs[0];
    return hit ? [{ object: hit }] : [];
  }
}
export const LinearFilter = 1006;
export const SRGBColorSpace = 'srgb';
