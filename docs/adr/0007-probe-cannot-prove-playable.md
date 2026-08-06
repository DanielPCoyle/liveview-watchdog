# ADR-0007 — The probe verifies reachable-and-live, not deliverable

**Status:** Accepted, with a known gap · 2026-08-05

## Context

Feeds are validated before they reach the wall: HLS or not, live or VOD, master
resolved one level, and — the one a naive check misses — the *segments* fetched
to confirm the media is CORS-reachable, not just the playlist.

Arlington County VA's public traffic cameras pass every one of those checks and
are unusable. Measured: the origin served a 10-second segment in ~14 seconds —
below real time, single stream, on an idle connection. Playback can never reach
the live edge. All four tiles went stale within 90 seconds. The browser console
said `ERR_EMPTY_RESPONSE`, which reads like an outage and isn't one.

## Decision

State the gap rather than paper over it. The probe answers *"is this reachable
and live"*, not *"can this be delivered fast enough to play"*. The Arlington
camera stays in the catalogue, labelled, as the honest example — it is neither
up nor down, which is the territory this whole project is about.

## Consequences

Throughput is the obvious next probe: fetch one segment and compare download
time against its `EXTINF` duration. Deferred rather than built, because the
seeded feeds are verified by measurement and the smoke test now watches for
decay continuously.
