# ADR-0004 — One WebGL surface, not N video elements

**Status:** Accepted · 2026-08-05

## Context

A video wall cannot be N `<video>` elements: each is a separately composited
layer the browser lays out, paints and blends every frame.

## Decision

Every feed is drawn as a textured quad in one WebGL surface. The DOM draws only
the HUD, positioned over the canvas.

## Alternatives rejected

- **DOM video elements.** The thing being replaced.
- **Keeping the A/B benchmark that justified this.** See below.

## Consequences

It does not fix decode, which is the real ceiling — one decoder per stream. The
production answer is a low-resolution sub-stream for wall tiles; selecting a
feed already drives that policy (focused uploads every frame, the strip is
rate-capped).

**No performance numbers are quoted anywhere, on purpose.** The first
GPU-vs-DOM benchmark looked decisive and was measuring nothing: the scene was
being rebuilt ~10x/second, and plain `THREE.Texture` does not take three.js's
video upload path, so the tiles were black the whole time. It measured the cost
of uploading nothing and explained it with a theory about the cost of
uploading. The numbers were deleted rather than corrected.
