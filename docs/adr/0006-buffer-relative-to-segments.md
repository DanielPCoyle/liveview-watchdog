# ADR-0006 — Buffer headroom is relative to segment duration

**Status:** Accepted · 2026-08-05 — corrects an earlier bug

## Context

The forward buffer was `maxBufferLength: 3` — deliberately small, so a stalled
feed surfaces in seconds instead of coasting. That is three segments of
headroom on the 1-second feeds it was tuned against, and **less than one
segment** on a public traffic camera publishing 10-second segments.

The player sat permanently at the live edge. Any jitter in when the encoder
published drained the buffer, playback stalled, and the watchdog dutifully
reported signal loss. The reports were true — frames really did stop — and the
cause was this configuration, not the camera.

## Decision

Headroom comes from the stream's own `EXT-X-TARGETDURATION` (two segments),
floored at the original 3s. This is what the original intent actually implied.

## Consequences

One camera still alarmed afterwards: Caltrans `NB5CrownValley`, whose playlist
genuinely stands still for ~14s at a time and then jumps two segments. That is
a true positive, so it stays in the catalogue as the feed that alarms with no
fault injection at all — and out of the default wall, because a demo that
cries wolf on first load teaches you to ignore it.
