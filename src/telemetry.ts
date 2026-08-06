/**
 * Analytics and error reporting, both opt-in and both loaded lazily.
 *
 * Neither vendor ships in the bundle unless it is configured. `import()` inside
 * the enable path means an unconfigured build never downloads Sentry or gtag —
 * the same reason the Firebase driver is code-split. A monitoring demo that
 * costs 40kb of third-party JavaScript to watch four cameras would be arguing
 * against itself.
 *
 * Set in `.env` (see `.env.example`):
 *   VITE_SENTRY_DSN   — error reporting
 *   VITE_GA_ID        — GA4 measurement id
 */

type Params = Record<string, string | number | boolean | null | undefined>;

let sentry: typeof import('@sentry/react') | null = null;
let gaReady = false;

/** Domain events worth a name. Deliberately a closed set: an analytics call
 *  sprinkled per click produces dashboards nobody can read. */
export type TrackedEvent =
  | 'feed_registered'
  | 'feed_removed'
  | 'feed_edited'
  | 'feed_focused'
  | 'feed_ignored'
  | 'feed_reordered'
  | 'group_switched'
  | 'fault_injected'
  | 'signal_lost'
  | 'signal_restored'
  | 'escalation_submitted'
  | 'report_opened';

export async function initTelemetry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (dsn) {
    try {
      sentry = await import('@sentry/react');
      sentry.init({
        dsn,
        // No session replay and no performance tracing: this page decodes video
        // continuously, so both would be expensive and neither answers the
        // question errors are being collected for.
        tracesSampleRate: 0,
        environment: import.meta.env.MODE,
      });
    } catch {
      sentry = null;   // reporting must never be the thing that breaks the wall
    }
  }

  const gaId = import.meta.env.VITE_GA_ID as string | undefined;
  if (gaId) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.async = true;
        s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('gtag blocked'));
        document.head.appendChild(s);
      });
      const w = window as unknown as { dataLayer: unknown[]; gtag: (...a: unknown[]) => void };
      w.dataLayer = w.dataLayer || [];
      w.gtag = function gtag(...args: unknown[]) { w.dataLayer.push(args); };
      w.gtag('js', new Date());
      w.gtag('config', gaId);
      gaReady = true;
    } catch {
      gaReady = false;  // ad blockers are the common case, not an error
    }
  }
}

export function track(event: TrackedEvent, params?: Params) {
  if (!gaReady) return;
  const w = window as unknown as { gtag?: (...a: unknown[]) => void };
  w.gtag?.('event', event, params);
}

/**
 * Report a caught error. Takes the same shape whether Sentry is configured or
 * not, so call sites never branch on whether reporting is on.
 */
export function captureError(err: unknown, context?: Params) {
  if (sentry) sentry.captureException(err, context ? { extra: context } : undefined);
  else console.error('[liveview-watchdog]', err, context ?? '');
}

/** Whether error reporting is actually wired — surfaced in the UI so nobody
 *  assumes failures are being collected when they are not. */
export function reportingEnabled() {
  return sentry !== null;
}
