/**
 * Telemetry when it IS configured.
 *
 * Both vendors are mocked, because the assertions worth making are about this
 * project's rules rather than theirs: no performance tracing on a page that
 * decodes video continuously, and — the important one — a vendor that fails to
 * load must never be the thing that breaks the wall. Ad blockers are the common
 * case, not an exceptional one.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let initArgs: Record<string, unknown> | null = null;
let captured: Array<{ err: unknown; ctx?: unknown }> = [];
let sentryThrows = false;

mock.module('@sentry/react', () => ({
  init: (o: Record<string, unknown>) => {
    if (sentryThrows) throw new Error('sentry unavailable');
    initArgs = o;
  },
  captureException: (err: unknown, ctx?: unknown) => captured.push({ err, ctx }),
}));

const env = import.meta.env as unknown as Record<string, string | undefined>;

beforeEach(() => {
  initArgs = null; captured = []; sentryThrows = false;
  document.head.innerHTML = '';
  delete (window as unknown as { gtag?: unknown }).gtag;
  delete (window as unknown as { dataLayer?: unknown }).dataLayer;
});
afterEach(() => {
  env.VITE_SENTRY_DSN = undefined;
  env.VITE_GA_ID = undefined;
  mock.restore();
});

describe('Sentry, when a DSN is present', () => {
  test('initialises, and declares reporting on', async () => {
    env.VITE_SENTRY_DSN = 'https://abc@sentry.test/1';
    const t = await import('./telemetry');
    await t.initTelemetry();
    expect(initArgs).not.toBeNull();
    expect(initArgs!.dsn).toBe('https://abc@sentry.test/1');
    expect(t.reportingEnabled()).toBe(true);
  });

  test('performance tracing stays off — this page decodes video continuously', async () => {
    env.VITE_SENTRY_DSN = 'https://abc@sentry.test/1';
    const t = await import('./telemetry');
    await t.initTelemetry();
    expect(initArgs!.tracesSampleRate).toBe(0);
  });

  test('errors reach the reporter with their context', async () => {
    env.VITE_SENTRY_DSN = 'https://abc@sentry.test/1';
    const t = await import('./telemetry');
    await t.initTelemetry();
    const boom = new Error('tile exploded');
    t.captureError(boom, { feed: 'CAM-1' });
    expect(captured.length).toBe(1);
    expect(captured[0].err).toBe(boom);
  });

  test('a vendor that fails to load leaves the app running and reporting off', async () => {
    sentryThrows = true;
    env.VITE_SENTRY_DSN = 'https://abc@sentry.test/1';
    const t = await import('./telemetry');
    await expect(t.initTelemetry()).resolves.toBeUndefined();
    expect(t.reportingEnabled()).toBe(false);
    // And captureError still works, via the console fallback.
    const original = console.error;
    console.error = () => {};
    try { expect(() => t.captureError(new Error('x'))).not.toThrow(); }
    finally { console.error = original; }
  });
});

describe('GA4, when a measurement id is present', () => {
  test('injects the tag script and queues events in the shape gtag.js reads', async () => {
    env.VITE_GA_ID = 'G-TEST123';
    const t = await import('./telemetry');
    await t.initTelemetry();

    const script = document.head.querySelector('script') as HTMLScriptElement | null;
    expect(script).not.toBeNull();
    expect(script!.src).toContain('G-TEST123');

    const dl = (window as unknown as { dataLayer: IArguments[] }).dataLayer;
    // Primed before the script arrives, so nothing tracked meanwhile is lost.
    expect([...dl].some((a) => a[0] === 'js')).toBe(true);
    expect([...dl].some((a) => a[0] === 'config' && a[1] === 'G-TEST123')).toBe(true);

    t.track('signal_lost', { cam: 'CAM-1' });

    /**
     * Entries must be arguments objects, not arrays. An array queues, reads
     * fine in a console, and is never transmitted — which is exactly how this
     * shipped to production once already.
     */
    const last = dl[dl.length - 1];
    expect(Array.isArray(last)).toBe(false);
    expect(Object.prototype.toString.call(last)).toBe('[object Arguments]');
    expect(last[0]).toBe('event');
    expect(last[1]).toBe('signal_lost');
  });

  test('a blocked tag script is not an error, and track stays safe', async () => {
    // What an ad blocker actually does: the append never succeeds.
    const realAppend = document.head.appendChild.bind(document.head);
    document.head.appendChild = (() => { throw new Error('blocked by client'); }) as typeof realAppend;
    env.VITE_GA_ID = 'G-TEST123';
    try {
      const t = await import('./telemetry');
      await expect(t.initTelemetry()).resolves.toBeUndefined();
      expect(() => t.track('escalation_submitted')).not.toThrow();
    } finally {
      document.head.appendChild = realAppend;
    }
  });
});
