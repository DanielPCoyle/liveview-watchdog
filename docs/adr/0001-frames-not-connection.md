# ADR-0001 — Liveness means frames advancing, not connection state

**Status:** Accepted · 2026-08-05

## Context

In a live-video product the catastrophic failure is not a crash. It is a tile
that looks live and isn't: the element reports healthy, nothing throws, no error
event fires, and the picture is thirty seconds old. Nothing pages anyone,
because nothing is broken — it is just absent. An operator trusts it.

Most dashboards answer *"is it connected?"* — typically
`readyState >= 2 && !paused && !error`.

## Decision

Liveness is a claim about **frames advancing**, measured from
`getVideoPlaybackQuality().totalVideoFrames`, and nothing else is allowed to
stand in for it.

## Alternatives rejected

- **`readyState` thresholds.** A stricter `readyState >= 3` catches a plain
  buffer underrun, but *no* readyState-based check survives a frozen picture
  behind a healthy element. Tightening the threshold treats a symptom.
- **`requestVideoFrameCallback`.** The obvious API, and wrong here: rVFC fires
  on frame *presentation*, and these decoders are offscreen — the wall draws
  from their textures, not from the elements. Every feed reported dead.
- **`VideoFrameMetadata.presentedFrames`.** Counts compositor presentations and
  can exceed decoded frames, which overstates "frames we missed".

## Consequences

Exact per-frame timestamps are lost, so the displayed statistic is decode
interval and is labelled as such. The naive check is still computed alongside
the real one, so the two can be compared.
