# ADR-0002 — The watchdog owns its clock, in a Worker

**Status:** Accepted · 2026-08-05

## Context

A liveness check that runs on the main thread is a victim of the very jank it
is meant to detect. While the thread is blocked its timer does not fire either,
so nothing notices that nothing is happening — silence is read as health.

## Decision

The watchdog runs in a Web Worker that owns the clock. The main thread only
emits per-frame heartbeats; the worker decides what those heartbeats mean.

## Consequences

Timestamps cross a thread boundary, and **a Worker has its own
`performance.now()` time origin**. Comparing across it silently offset every
staleness reading by a constant — it surfaced as `stale for -2.6s`. Both sides
now use `Date.now()`: lower resolution, same clock. Detection had still fired
correctly, because the value grows without bound once frames stop; every number
displayed was simply wrong.
