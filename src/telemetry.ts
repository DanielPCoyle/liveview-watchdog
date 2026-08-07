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
  | 'report_opened'
  | 'wall_started';

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
      const w = window as unknown as { dataLayer: unknown[]; gtag: (...a: unknown[]) => void };

      /**
       * The canonical gtag bootstrap, in the canonical order, and both details
       * matter.
       *
       * `dataLayer.push(arguments)` pushes the arguments OBJECT, not an array.
       * gtag.js reads the queue expecting arguments-shaped entries; pushing a
       * real array lands in the queue, reads correctly in a console, and is
       * never transmitted. That failure is completely silent — the events were
       * visibly queued and no request ever left the browser.
       *
       * The queue is also primed BEFORE the script loads, which is what makes
       * it a queue: anything tracked while the tag is still downloading is
       * replayed on arrival rather than dropped.
       */
      w.dataLayer = w.dataLayer || [];
      // eslint-disable-next-line prefer-rest-params
      w.gtag = function gtag() { w.dataLayer.push(arguments); };
      w.gtag('js', new Date());
      w.gtag('config', gaId);
      gaReady = true;

      const s = document.createElement('script');
      s.async = true;
      s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`;
      // An ad blocker is the common case, not an exceptional one: the queue
      // simply never drains, and nothing else in the app notices.
      s.onerror = () => { gaReady = false; };
      document.head.appendChild(s);
    } catch {
      gaReady = false;
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
