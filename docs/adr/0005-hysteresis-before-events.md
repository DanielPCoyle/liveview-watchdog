# ADR-0005 — Detection is instant, events are confirmed

**Status:** Accepted · 2026-08-05

## Context

Under load a feed flaps: the machine stalls a decode, the watchdog correctly
calls it stale, it recovers, and the cycle repeats — producing a dozen
lost/restored pairs in twenty seconds and a tile that jumps in and out of the
main area. Every individual reading is true. The sequence is useless.

## Decision

A state must hold for 12 consecutive worker ticks (~1.2s) before it counts as
an *event*. The pill shows raw state immediately; only the incident log and
auto-promotion require confirmation.

## Consequences

Measured after: 0 incidents in 50s under 21s of blocking time, while a genuine
freeze still produced exactly one lost/restored pair.
