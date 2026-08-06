import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureError } from './telemetry';

/**
 * A render crash on a monitoring wall is the worst possible failure: the
 * operator is left with a blank page and no signal that anything is wrong —
 * the same "looks fine, isn't" shape the watchdog exists to catch, one level up.
 *
 * So the boundary states plainly that the wall stopped, shows what threw, and
 * offers the one action that helps. It does not try to re-render the subtree:
 * the decoders and the WebGL context are gone with it, and a half-recovered
 * wall claiming to be live is worse than an honest dead one.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    captureError(error, { componentStack: info.componentStack ?? '' });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fatal" role="alert">
        <h1>The wall stopped</h1>
        <p>
          A rendering error took the video wall down. Nothing is being monitored right now —
          this page is not showing stale feeds, it is showing none.
        </p>
        <pre>{error.message}</pre>
        <button className="on" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
