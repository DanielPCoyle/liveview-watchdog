# ADR-0008 — Hermetic e2e on mocks; frame-aware smoke on production

**Status:** Accepted · 2026-08-05

## Context

The end-to-end suite exercises a wall built on third-party municipal cameras.
This project's own documentation records those origins rotting. A suite that
goes red when a highway camera reboots is a suite people learn to ignore.

But a purely mocked suite proves nothing about whether the deployed thing
works, and the deployed thing's most likely failure is exactly that decay.

## Decision

Two suites answering two questions.

**Hermetic e2e** runs against `?mock=1` — canvas-backed synthetic feeds served
in the browser. The transport is replaced; everything downstream is real, so
the worker clock, hysteresis, auto-promotion and incident log are genuinely
exercised offline. Freezing a mock does **not** stop its heartbeat: it keeps
delivering frames at full rate and reports the same media time, so drift
collapses and the tile is caught at `stale 0.0s` — zero seconds since the last
frame, and dead. Anything else would test the easy case.

**Production smoke** runs against the real deployment every six hours and
asserts that a real camera is advancing frames. Deliberately not a `curl` of
index.html: a 200 for the shell is the naive check, shipped. Tolerance is
deliberate — a single dead municipal camera is not an alert; *nothing* alive is.

## Consequences

Building the mock exposed a real bug in it: media time derived from tick
*count*, plus a state update per frame per tile, starved the interval so media
ran at ~0.22x wall clock and every mock feed read stale for a reason that was
purely an artefact. Media now comes from elapsed time. The mock had reproduced
the project's own thesis against itself — a measurement that looked right and
was measuring the wrong thing.
