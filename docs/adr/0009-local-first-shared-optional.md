# ADR-0009 — Local by default, shared wall opt-in behind one facade

**Status:** Accepted · 2026-08-05

## Context

A video wall is not a single-operator tool. If one operator acknowledges a dead
camera, everyone else watching the same wall needs to see it — otherwise two
people work the same incident and a third assumes somebody has it.

But requiring a Firebase project before `npm run dev` shows anything would
trade a working demo for a feature most readers will never configure.

## Decision

One small facade over two real drivers: `localStorage` (default) and Firebase
Realtime Database (opt-in via env). This is the single deliberate abstraction
in the codebase, justified because there are genuinely two implementations
rather than a speculative interface around one. The Firebase SDK is loaded with
`import()` inside the driver, so an unconfigured build never downloads it.

The same reasoning covers Sentry and GA4: both opt-in, both code-split, neither
shipped unless configured. A monitoring demo that costs 40kb of third-party
JavaScript to watch four cameras would be arguing against itself.

## Consequences

Any Firebase failure falls back to the local driver: a shared wall that cannot
reach its backend must degrade to a working private wall, never to a blank
screen. The header states which mode is active, because "can other people
change this wall" is a fact the operator should not have to infer.
