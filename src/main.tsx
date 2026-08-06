import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { initTelemetry, captureError } from './telemetry';
import './styles.css';

// Fire and forget: telemetry must never delay the first frame, and a blocked
// gtag or an unreachable Sentry must never stop the wall from starting.
void initTelemetry();

// Anything that escapes React — a rejected promise in an effect, an error in a
// raw event listener — is still worth collecting, and is invisible otherwise.
window.addEventListener('unhandledrejection', (e) => captureError(e.reason, { kind: 'unhandledrejection' }));
window.addEventListener('error', (e) => captureError(e.error ?? e.message, { kind: 'window.error' }));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
