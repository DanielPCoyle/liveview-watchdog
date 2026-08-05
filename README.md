# Liveview Watchdog

**A tile is only *live* if frames are advancing. Connection state is not liveness.**

A live-video wall that can tell a working feed from a dead one and prove it, built on real public HLS streams, composited on the GPU, with the watchdog running off the main thread.

---

## The problem

In a live-video product the catastrophic failure isn't a crash. It's a tile that **looks** live and isn't: the element reports healthy, nothing throws, no error event fires — and the picture is thirty seconds old. An operator trusts it. Nothing pages anyone, because nothing is broken; it's just absent.

Most dashboards answer *"is it connected?"* That's a proxy. This answers *"are frames still arriving, and is the content actually moving?"*

## What it does

- **Frame-aware liveness** per feed, with a `naive "is it connected?"` toggle so you can watch the connection check report a healthy feed that stopped ages ago.
- **Auto-promote on signal loss.** Any feed that loses signal moves into the main area automatically; several can share it, because an incident can involve more than one camera. Recovery shows a **Signal restored** toast, holds for four seconds so it can be read, then shrinks back to the carousel.
- **Click to focus**, ✕ or `Esc` to return. Selection drives real policy, not just layout (below).
- **Feed registry on the grid.** Feeds are registered, not hard-coded — an empty slot sits in the wall where the next feed will go, and each tile carries its own remove control. Groups live behind **manage groups**; only the active group is mounted, because decode is the ceiling. Registering offers a **catalogue of verified feeds** in a searchable dropdown — including one deliberately-broken entry (Apple bipbop, which is VOD) so you can see a rejection — and still accepts any pasted `.m3u8`. Either way the URL is probed (live / VOD / CORS) before it reaches the wall.
- **Roster panel per group.** The wall answers *"is anything wrong"*; the roster answers *"where is the one I'm thinking of"* — a different question, and the one that gets slow first. Search by name or source URL, filter by liveness, and **hover a row to swell its tile on the wall** so the list and the picture stay tied together without committing to a layout change. Click to promote. Each row carries **report / ignore / edit / mute / remove**, and rows **drag to reorder** — the roster order *is* the wall order, so rearranging the list rearranges the grid (alt + ↑/↓ does the same without a mouse; reordering is disabled while the list is filtered, because arranging rows you can't see has no defined meaning).
- **Ignore is acknowledgement, not muting.** An ignored feed keeps being watched, keeps counting as signal lost and keeps writing to the incident log — it just stops being auto-promoted, and the header shows how many feeds are being suppressed. A manual pick still overrides it.
- **Per-feed audio.** Everything starts muted so autoplay works; the click supplies the gesture unmuting requires.
- **Report incident** — escalate a feed with the measurements attached automatically.
- **Incident log** timestamping every transition in and out of signal loss.

## How liveness is measured

**Decoded frames, not presented frames.** The obvious approach is `requestVideoFrameCallback`, and it's wrong here: rVFC fires on frame *presentation*, and these decoders are offscreen — the wall is drawn from their textures, not from the elements. Every feed reported dead. `getVideoPlaybackQuality().totalVideoFrames` counts decoded frames regardless of presentation, so that's the heartbeat. The cost is exact per-frame timestamps, so the stat shown is decode interval, labelled as such.

**The watchdog owns its clock, in a Worker.** A liveness check on the main thread is a victim of the jank it's meant to detect: while the thread is blocked its timer doesn't fire either, and silence reads as health. Hit **inject main-thread jank** to see the difference.

**Frame arrival alone is not enough.** When a live source dies, hls.js enters a reload loop — it retries the stalled playlist, each attempt decodes a frame or two, and `currentTime` resets each cycle. Frames keep arriving, so an arrival-only watchdog sits at "degraded" forever and never calls it, while the operator is shown the same few seconds on repeat. Observed directly: a feed dead for two minutes still producing frames every ~1.1s.

So liveness also requires **windowed media drift** — how far the media clock moves per second of wall clock, over the last six seconds. ~1.00 healthy; a reload loop replays the same window and collapses toward 0. A feed with frames arriving and drift below 0.35 is called stale, because to the operator it is.

## Escalation

**Report incident** on a promoted feed opens a form with severity and a note — and attaches the evidence captured at that moment: liveness, how long it's been stale, media drift, decoded and dropped counts, and the source URL. Escalations are listed in the sidebar and copy out as JSON.

The point is that the person receiving it gets numbers rather than "camera 3 looks funny". That's the difference between a ticket someone can action and one that starts with a round of questions.

## Sources: real public CCTV, and what it took to find it

The wall opens on four **Caltrans highway cameras** — genuine public road CCTV, published as open HLS with CORS on playlist **and** segments:

| | |
|---|---|
| `I5-SR55` | NB I-5 at SR-55, Orange County — `wzmedia.dot.ca.gov/D12/NB5SR55.stream/...` |
| `I5-OSOPKWY` | NB I-5 at Oso Pkwy — `wzmedia.dot.ca.gov/D12/NB5OsoPkwy.stream/...` |
| `SR88-PINEGROVE` | EB SR-88 Pine Grove, Amador County — `wzmedia.dot.ca.gov/D10/...` |
| `D7-CCTV337` | District 7, Los Angeles metro — `wzmedia.dot.ca.gov/D7/CCTV-337.stream/...` |

Fixed cameras pointed at roads are the right material for this specific tool, and not because they look the part. **They are the hardest case for a human watching a wall**: the scene barely changes, so a frozen tile and a working one are visually identical until a car should have moved and didn't. Broadcast news, where a freeze is obvious in about a second, quietly makes the problem look easier than it is — the news channels are kept in a second group for contrast, and because they are multi-variant, which the focused-quality policy needs to have anything to switch between. All feeds here are third-party; this project does not own the content.

Labels are taken from the **stream path the operator publishes**, not from a third-party camera list. A tool whose selling point is attaching verified evidence should not open by guessing which intersection you are looking at.

### CORS and "is it live" are not sufficient tests

Arlington County VA also publishes its traffic cameras as open HLS, and they were the first choice: real municipal CCTV, live sliding window, CORS-clean on playlist and segments. They pass **every check this project's probe makes**, and they are unusable.

Measured 2026-08-05: the origin served a 10-second segment in ~14 seconds — **below real time, single stream, on an idle connection**. Playback can never reach the live edge, so all four tiles went stale within 90 seconds and stayed there. The browser console said `ERR_EMPTY_RESPONSE`, which reads like an outage and isn't one.

So the probe now has a known blind spot, stated rather than papered over: it verifies a feed is *reachable and live*, not that it is *deliverable fast enough to play*. The camera is kept in the catalogue, labelled, as the honest example — it is neither up nor down, which is exactly the territory this project is about. Throughput is the next thing worth probing: fetch one segment, compare download time against its `EXTINF` duration.

### A buffer setting that manufactured its own outages

The forward buffer was `maxBufferLength: 3` — deliberately small, so a stalled feed surfaces in seconds instead of coasting on buffered segments. That is three segments of headroom on the 1-second feeds it was tuned against, and **less than one segment** on a public traffic camera publishing 10-second segments. The player sat permanently at the live edge; any jitter in when the encoder published drained the buffer, playback stalled, and the watchdog dutifully reported signal loss.

The reports were true — frames really did stop — and the cause was this config, not the camera. Buffer headroom is now taken from the stream's own `EXT-X-TARGETDURATION` (two segments, floored at the original 3s), which is the setting the original intent actually implied. One camera still alarmed afterwards: `NB5CrownValley`, whose playlist genuinely stands still for ~14s at a time and then jumps two segments. That one is a true positive, so it stays in the catalogue as the feed that alarms with no fault injection at all.

### The broadcast candidates

Getting to two working news sources meant rejecting most of the field. The failure modes are not obvious, and **one of my own verdicts was wrong** — recorded below, because the mistake is more instructive than the table:

| Candidate | Verdict (browser-verified) |
|---|---|
| `test-streams.mux.dev` | **VOD.** hls.js buffers a VOD asset end-to-end — `buffered` came back `[10, 300]`, 208s ahead — so it cannot be starved and no live-edge behaviour occurs. An earlier version of this project ran on one, i.e. demoed a live product on video-on-demand. |
| Apple `bipbop` | **VOD.** CORS is fine — see the correction below. |
| Unified Streaming live channels | Genuinely live and CORS-clean, but colour-bar **test patterns**, not footage. Fine for correctness, useless for showing what the thing is for. |
| Akamai `cph-p2p-msl`, `moctobpltc` | Masters resolve; their advertised variant playlists **404**. |
| Bitmovin, AWS `skip_armstrong`, ZDF | 403. |
| Das Erste, Euronews | Genuinely CORS-blocked in the browser. |
| France24 | **Intermittent** — fetched successfully once and failed 30s later. Not dependable. |

### A correction, and the methodology error behind it

I originally recorded Apple's `bipbop` as *"no `Access-Control-Allow-Origin` header at all"*. That is **wrong**. The browser fetches it fine; it is simply VOD.

The cause: I detected CORS with `curl -I`, i.e. a **HEAD** request. A server can answer HEAD without the headers it returns on GET, so several "no CORS" verdicts in the first sweep were artifacts of the measuring instrument, not properties of the servers. The browser is the only authority that matters for this question, and re-running every check as a browser `fetch()` changed two answers.

Which is the same failure this whole project is about: a measurement that returns a confident, plausible value while measuring the wrong thing.

**What using public feeds costs.** An earlier version generated local HLS with ffmpeg, which allowed killing a camera at the *encoder* with `SIGSTOP` — the most honest possible "the camera died". You can't do that to someone else's stream, so `freeze` is now client-side `hls.stopLoad()`: the small live buffer starves in seconds, then hls.js drops into its reload loop. That exercises the *harder* detection path rather than the easy one.

## Focus view — not just layout

Selection drives budget, not presentation. An operator scans the wall and studies one feed, so the rest needn't cost full rate:

- the focused feed uploads its texture **every frame**; carousel tiles are rate-capped
- the focused feed requests full quality (`hls.currentLevel = -1`); the rest pin to the lowest rendition — and these sources genuinely have two renditions, so it bites

## Faults are real, never cosmetic

| Fault | What actually happens |
|---|---|
| `freeze` | `hls.stopLoad()`. The live buffer starves within seconds, then a reload loop. |
| `jank` | A genuine main-thread busy-loop. Real long tasks, real dropped frames. |
| `low-q` | Pins hls.js to its lowest rendition — real bitrate degradation. |

## Running it

```bash
bun install     # or npm install
bun run dev     # http://localhost:5183
```

No other setup — the feeds are public. Start with 1–2 feeds; each additional 720p stream is a full decoder, and that is the real ceiling (see below).

## Two bugs worth recording

**A benchmark I threw away.** The first GPU-vs-DOM A/B looked decisive — GPU 60fps vs DOM 32fps at 4 feeds, GPU collapsing to 5.5fps at 24 — and I'd written a confident explanation about texture-upload bandwidth. Then two bugs surfaced: the scene was being rebuilt ~10×/second (status and stream identity shared one prop, so the layout effect tore down every mesh on each watchdog tick), and **the tiles were black the whole time** — plain `THREE.Texture` doesn't take three.js's video upload path, so no uploads were happening at all. I had measured the cost of uploading nothing and explained it with a theory about the cost of uploading. Both fixed; the numbers were deleted rather than corrected, because a measurement of the wrong thing doesn't become right when you adjust it.

**Every staleness figure was silently offset.** The worker compared its own `performance.now()` against timestamps taken on the main thread — and a Worker has its **own time origin**. Detection still fired, because the value grows without bound once frames stop, so it crossed the threshold anyway. But every number displayed was wrong by a constant. It surfaced as a negative reading: `stale for -2.6s`. Both sides now use `Date.now()`.

Both are the same shape as the failure this project is about: something that reports a plausible number while measuring the wrong thing.

## Honest limitations

**No compositor performance numbers are quoted anywhere.** See above. Re-measuring needs a quiet machine; on the development laptop, DOM's own 24-feed figure drifted from 30fps to 8.9fps between runs.

**Decode is the ceiling, and it's low.** Four concurrent 720p decodes saturated the dev machine — ~48 frames decoded in 18s with 16.9s of blocking time, and the watchdog correctly called every feed stale because frames genuinely weren't arriving. The production answer is a low-resolution sub-stream for wall tiles; the policy is wired, the sources only offer two renditions.

**The naive check modelled here is a realistic weak one**, not a straw man — `readyState >= 2 && !paused && !error`, a common shipped pattern. A stricter `readyState >= 3` would catch a plain buffer underrun. What defeats *every* readyState-based check is a frozen picture with an advancing clock, which is why frame advancement and media drift are the signals rather than a better threshold.

**Hysteresis, and why it exists.** A state must hold for 12 consecutive worker ticks before it counts as an event. Without it a feed under load flaps — the machine stalls a decode, the watchdog correctly calls it stale, it recovers, and the cycle repeats, producing a dozen lost/restored pairs in twenty seconds. Every individual reading was true and the sequence was still useless. Measured after: 0 incidents in 50s under 21s of blocking time, while a genuine freeze still produced exactly one lost/restored pair. The pill shows raw state immediately; only *events* require confirmation.

**Not built:** pixel-level frozen-frame detection (hash consecutive downsampled frames) for the advancing-clock case; culling off-screen tiles.

## Stack

React 19 · TypeScript · Vite · three.js · hls.js · Web Workers
