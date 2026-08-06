/**
 * The long-task observer, plus the error boundary.
 *
 * Both are about the app being honest when it is degraded, so both are tested
 * for what they report rather than for what they render.
 */
import { describe, expect, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { useLongTasks } from './perf';
import { ErrorBoundary } from './ErrorBoundary';

describe('useLongTasks', () => {
  test('starts at zero and survives a browser with no PerformanceObserver', () => {
    const original = globalThis.PerformanceObserver;
    // @ts-expect-error deliberately removing the API to take the fallback path
    delete globalThis.PerformanceObserver;
    try {
      const { result } = renderHook(() => useLongTasks());
      expect(result.current).toEqual({ longTasks: 0, longestTaskMs: 0, blockedMs: 0 });
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test('accumulates entries and reports blocking time past the 50ms budget', async () => {
    let emit: ((list: { getEntries: () => Array<{ duration: number }> }) => void) | null = null;
    class FakeObserver {
      constructor(cb: typeof emit) { emit = cb; }
      observe() {}
      disconnect() {}
    }
    const original = globalThis.PerformanceObserver;
    globalThis.PerformanceObserver = FakeObserver as unknown as typeof PerformanceObserver;
    try {
      const { result } = renderHook(() => useLongTasks());
      emit!({ getEntries: () => [{ duration: 120 }, { duration: 60 }] });
      // The hook publishes on a 400ms cadence rather than per entry.
      await new Promise((r) => setTimeout(r, 500));
      expect(result.current.longTasks).toBe(2);
      expect(result.current.longestTaskMs).toBe(120);
      // Blocking time is everything past the 50ms budget: 70 + 10.
      expect(result.current.blockedMs).toBe(80);
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test('an observer that throws on observe does not take the app down', () => {
    class Hostile {
      observe() { throw new Error('unsupported entry type'); }
      disconnect() {}
    }
    const original = globalThis.PerformanceObserver;
    globalThis.PerformanceObserver = Hostile as unknown as typeof PerformanceObserver;
    try {
      expect(() => renderHook(() => useLongTasks())).not.toThrow();
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });
});

describe('ErrorBoundary', () => {
  const Boom = () => { throw new Error('render exploded'); };

  test('renders children when nothing is wrong', () => {
    render(<ErrorBoundary><p>the wall</p></ErrorBoundary>);
    expect(screen.getByText('the wall')).toBeDefined();
  });

  test('states that the wall stopped, and does not claim anything is still live', () => {
    const original = console.error;
    console.error = () => {};              // React logs the caught error itself
    try {
      render(<ErrorBoundary><Boom /></ErrorBoundary>);
    } finally {
      console.error = original;
    }
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('The wall stopped')).toBeDefined();
    // The distinction that matters: nothing monitored, not stale feeds shown.
    expect(screen.getByText(/it is showing none/)).toBeDefined();
    expect(screen.getByText('render exploded')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined();
  });
});
