/**
 * A stand-in for hls.js that records what the code under test asked of it.
 *
 * Registered in the preload rather than inside a test file: `mock.module` only
 * affects imports that happen after it, so a suite that imports `useTile`
 * without the mock would bind the real library and win the race depending on
 * file order. That is exactly the failure CI caught and a local run hid.
 */
export class FakeHls {
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
