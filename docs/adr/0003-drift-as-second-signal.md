# ADR-0003 — Frame arrival alone is insufficient; windowed media drift

**Status:** Accepted · 2026-08-05

## Context

When a live source dies, hls.js enters a reload loop: it retries the stalled
playlist, each attempt decodes a frame or two, and `currentTime` resets each
cycle. Frames keep arriving. An arrival-only watchdog sits at "degraded"
forever and never calls it, while the operator is shown the same few seconds on
repeat. Observed directly: a feed dead for two minutes, still producing frames
every ~1.1s.

## Decision

Liveness also requires **windowed media drift** — how far the media clock moves
per second of wall clock over the last six seconds. ~1.00 is healthy; a reload
loop replays the same window and collapses toward 0. Frames arriving with drift
below 0.35 is called stale, because to the operator it is.

The worker reports *which* of the two conditions fired, so the incident log can
say "frames stale — arriving at full rate, picture not advancing" rather than
claiming frames stopped when they did not.

## Consequences

Drift needs a minimum span (2.5s) before it means anything, so this signal is
slower than arrival. That is acceptable: the failure it catches is the one that
otherwise goes unnoticed indefinitely.
