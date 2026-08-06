/**
 * DOM environment for component tests.
 *
 * The wall's UI is half the codebase and none of it is reachable without a
 * document, so the tests run in happy-dom with the three browser capabilities
 * it lacks stubbed here: WebGL (three.js), Worker (the watchdog), and canvas
 * 2D (roster thumbnails). Each stub is the smallest thing that lets the real
 * code run — the point is to exercise this project's logic, not to reimplement
 * the browser.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({
  url: 'http://localhost/',
  // happy-dom refuses to fetch external scripts. Treat the append as a
  // successful load so the analytics tag's success path is reachable; the
  // blocked path is simulated explicitly where it is under test.
  settings: { handleDisabledFileLoadingAsSuccess: true },
});

/** Workers: run the real watchdog module in-process, wired to postMessage. */
class StubWorker implements Partial<Worker> {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  static last: StubWorker | null = null;
  constructor() { StubWorker.last = this; }
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
  /** Test helper: push a status frame as the real worker would. */
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
(globalThis as unknown as { Worker: unknown }).Worker = StubWorker;
export { StubWorker };

/** Canvas 2D: enough surface for drawImage-based thumbnails to run. */
const ctx2d = {
  drawImage() {}, fillRect() {}, fillText() {},
  set fillStyle(_v: string) {}, set font(_v: string) {},
  getImageData: (_x: number, _y: number, w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4).fill(120), width: w, height: h,
  }),
};
HTMLCanvasElement.prototype.getContext = function getContext(kind: string) {
  return kind === '2d' ? (ctx2d as unknown as CanvasRenderingContext2D) : null;
} as HTMLCanvasElement['getContext'];
// happy-dom type-checks srcObject, so this must be a genuine MediaStream.
(HTMLCanvasElement.prototype as unknown as { captureStream: () => MediaStream })
  .captureStream = () => new MediaStream();

/** Media elements: happy-dom has no playback engine. */
Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { value: 4, writable: true });
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};
(HTMLMediaElement.prototype as unknown as { getVideoPlaybackQuality: () => unknown })
  .getVideoPlaybackQuality = () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 });

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  } as unknown as typeof ResizeObserver;
}
