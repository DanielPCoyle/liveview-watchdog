/**
 * Telemetry is opt-in, and the contract worth testing is that being switched
 * OFF is a first-class state: `track` and `captureError` must be callable from
 * anywhere without a guard, and neither a missing DSN nor an ad blocker may
 * ever be the thing that breaks the wall.
 */
import { describe, expect, test } from 'bun:test';
import { captureError, reportingEnabled, track } from './telemetry';

describe('telemetry when nothing is configured', () => {
  test('reporting is honestly declared off', () => {
    expect(reportingEnabled()).toBe(false);
  });

  test('track is a safe no-op rather than a guard every call site must repeat', () => {
    expect(() => track('signal_lost', { cam: 'A' })).not.toThrow();
    expect(() => track('escalation_submitted')).not.toThrow();
  });

  test('captureError still surfaces the error instead of swallowing it', () => {
    const seen: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => seen.push(a);
    try {
      captureError(new Error('boom'), { where: 'test' });
    } finally {
      console.error = original;
    }
    expect(seen.length).toBe(1);
    expect(String(seen[0])).toContain('boom');
  });

  test('captureError accepts a non-Error, because rejections carry anything', () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(() => captureError('a string reason')).not.toThrow();
      expect(() => captureError(undefined)).not.toThrow();
    } finally {
      console.error = original;
    }
  });
});
