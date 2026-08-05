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

## Sources: real broadcast footage, and what it took to find it

| | |
|---|---|
| `DW-EN` | Deutsche Welle English — `dwamdstream102.akamaized.net/.../index.m3u8` |
| `TAGESSCHAU` | ARD Tagesschau — `tagesschau.akamaized.net/.../master.m3u8` |

Both are public-broadcaster news channels published as open HLS with CORS on playlist **and** segments, which is the signal that cross-origin playback is permitted. They are third-party feeds used here for testing; this project does not own the content.

Getting to two working sources meant rejecting most of the field, and the failure modes are not obvious:

| Candidate | Why |
|---|---|
| `test-streams.mux.dev`, `mux-pts-shift` | **VOD.** hls.js buffers a VOD asset end-to-end — `buffered` came back `[10, 300]`, 208s ahead — so it cannot be starved and no live-edge behaviour occurs. An earlier version of this project ran on one of these, which meant demoing a live product on video-on-demand. |
| Unified Streaming live channels | Genuinely live and CORS-clean, but **colour-bar test patterns**, not footage. Fine for correctness, useless for showing what the thing is actually for. |
| Apple `bipbop` | No `Access-Control-Allow-Origin` header at all. |
| Akamai `cph-p2p-msl`, `moctobpltc` | Masters resolve; their advertised variant playlists **404**. |
| Bitmovin, AWS `skip_armstrong`, ZDF | 403. |
| France24 | Playlist is CORS-enabled; **segments are not**. |
| Al Jazeera, Amagi/ABC, Das Erste, Euronews | Connection failure / 500 / no CORS. |

Verified live 2026-08-05 — media sequence advancing, segments returning 200 with CORS. Public endpoints rot; expect to re-check.

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

**Not built:** pixel-level frozen-frame detection (hash consecutive downsampled frames) for the advancing-clock case; culling off-screen tiles; hysteresis on auto-promote, which currently re-promotes a flapping feed on every transition.

## Stack

React 19 · TypeScript · Vite · three.js · hls.js · Web Workers
