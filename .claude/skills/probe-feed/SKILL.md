---
name: probe-feed
description: Verify a candidate public camera before it joins the feed catalogue - live vs VOD, master variant resolution, segment CORS, and throughput against real time. Use when the user offers a new .m3u8 URL, asks to add or replace a camera, or says a feed looks broken.
---

# probe-feed

The app's built-in probe answers *"is this reachable and live"*. It does **not**
answer *"can this be delivered fast enough to play"* — a gap
[ADR-0007](../../../docs/adr/0007-probe-cannot-prove-playable.md) documents,
discovered when Arlington County's cameras passed every check and were still
unusable at ~14 seconds to deliver 10 seconds of video.

This skill closes that gap before a URL reaches the catalogue.

## Checks, in order

1. **HTTP + CORS on the playlist.** Send `Origin:` and read
   `access-control-allow-origin`. Use **GET, never HEAD** — a server can answer
   HEAD without the headers it returns on GET, which produced two wrong verdicts
   in this repo's original stream survey.
2. **HLS, and live.** `#EXTM3U` present, `#EXT-X-ENDLIST` absent. VOD is
   disqualifying: it cannot go stale, so the watchdog has nothing to watch.
3. **Resolve one variant** if `#EXT-X-STREAM-INF` is present, and re-check
   there. Masters advertising variants that 404 are common.
4. **Segment CORS.** Fetch an actual `.ts` with `Range: bytes=0-1`. A playlist
   that is CORS-clean while its segments are not passes every naive check and
   fails the moment it plays.
5. **Throughput against real time.** Download one segment and compare elapsed
   time to its `#EXTINF` duration. **Slower than real time disqualifies the
   feed** regardless of every check above.
6. **Concurrently, at the wall's size.** Repeat step 5 with the number of feeds
   the group will actually run. Per-origin limits only appear under load.

## Output

Report per candidate: verdict, segment duration, download time, the ratio, and
CORS state. Emit a ready `FEED_CATALOG` entry only for feeds that clear every
step, with the label taken from **the operator's own stream path** — never from
a third-party camera list, and never guessed.

Record the measurement date in the `note`. These endpoints rot.
