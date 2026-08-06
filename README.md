# Liveview Watchdog

[![CI](https://github.com/DanielPCoyle/liveview-watchdog/actions/workflows/ci.yml/badge.svg)](https://github.com/DanielPCoyle/liveview-watchdog/actions/workflows/ci.yml)
[![E2E](https://github.com/DanielPCoyle/liveview-watchdog/actions/workflows/e2e.yml/badge.svg)](https://github.com/DanielPCoyle/liveview-watchdog/actions/workflows/e2e.yml)
[![Production smoke test](https://github.com/DanielPCoyle/liveview-watchdog/actions/workflows/smoke.yml/badge.svg)](https://github.com/DanielPCoyle/liveview-watchdog/actions/workflows/smoke.yml)

**A tile is only *live* if frames are advancing. Connection state is not liveness.**

A live-video wall that can tell a working feed from a dead one and prove it, built on real public HLS streams, composited on the GPU, with the watchdog running off the main thread.

> **Live demo:** <https://liveview-watchdog-production.up.railway.app> · **Hermetic mode:** append `?mock=1` for synthetic feeds that need no network · **Decisions:** [`docs/adr/`](docs/adr/README.md)

That third badge is the one worth explaining. It does not check that the site returns 200 — a 200 for the shell is precisely the naive check this project exists to distrust, and it stays green while every camera on the wall is dead. It loads the deployed app every six hours and asserts that a real camera is **advancing frames**. The project's own thesis, pointed at its own deployment.

---

## Contents

- [The problem](#the-problem) · [What it does](#what-it-does)
- [How liveness is measured](#how-liveness-is-measured) · [Two different failures](#two-different-failures-and-why-the-log-names-which)
- [Architecture](#architecture) · [Focus drives budget](#focus-view--not-just-layout) · [Faults](#faults-are-real-never-cosmetic)
- [Sources](#sources-real-public-cctv-and-what-it-took-to-find-it) · [When things break](#when-things-break)
- [Testing](#testing-two-suites-two-questions) · [Deployment](#deployment) · [Running it](#running-it)
- [Bugs worth recording](#bugs-worth-recording) · [Honest limitations](#honest-limitations)

---

## The problem

In a live-video product the catastrophic failure isn't a crash. It's a tile that **looks** live and isn't: the element reports healthy, nothing throws, no error event fires — and the picture is thirty seconds old. An operator trusts it. Nothing pages anyone, because nothing is broken; it's just absent.

Most dashboards answer *"is it connected?"* That's a proxy. This answers *"are frames still arriving, and is the content actually moving?"*

## What it does

- **Frame-aware liveness** per feed. The pill reports whether frames are advancing, not whether the element claims to be connected.
- **Auto-promote on failure.** Any feed that goes stale moves into the main area automatically; several can share it, because an incident can involve more than one camera. Recovery shows a **Signal restored** toast, holds four seconds so it can be read, then shrinks back to the carousel.
- **Click to focus**, ✕ or `Esc` to return. Selection drives real policy, not just layout ([below](#focus-view--not-just-layout)).
- **Feed registry on the grid.** Feeds are registered, not hard-coded — an empty slot sits in the wall where the next feed will go, and each tile carries its own remove control. Groups live behind **manage groups**; only the active group is mounted, because decode is the ceiling. Registering offers a **catalogue of verified feeds** in a searchable dropdown — including one deliberately-broken entry (Apple bipbop, which is VOD) so you can see a rejection — and still accepts any pasted `.m3u8`. Either way the URL is probed (live / VOD / CORS) before it reaches the wall.
- **Roster panel per group.** The wall answers *"is anything wrong"*; the roster answers *"where is the one I'm thinking of"* — a different question, and the one that gets slow first. Search by name or source URL, filter by liveness, and **hover a row to swell its tile on the wall** so the list and the picture stay tied together without committing to a layout change. Click to promote. Each row carries **report / ignore / edit / mute / remove**, and rows **drag to reorder** — the roster order *is* the wall order, so rearranging the list rearranges the grid (alt + ↑/↓ does the same without a mouse; reordering is disabled while the list is filtered, because arranging rows you can't see has no defined meaning).
- **Ignore is acknowledgement, not muting.** An ignored feed keeps being watched, keeps counting as stale and keeps writing to the incident log — it just stops being auto-promoted, and the header shows how many feeds are being suppressed. A manual pick still overrides it.
- **Incident history per feed, not one merged log.** Every transition is timestamped, and each row carries its own latest event plus a document icon opening that camera's full report: current liveness, stale duration, media drift, how many times it has dropped, every incident, every escalation, and a copy-as-JSON. A shared log is fine while you are watching it happen and useless afterwards — the question an operator actually asks is *"what has this camera been doing"*, and a merged stream answers it only by making you read past everyone else's events.
- **Report incident** — escalate a feed with the measurements attached automatically.
- **Per-feed audio.** Everything starts muted so autoplay works; the click supplies the gesture unmuting requires.
- **Responsive down to a phone.** Wide: roster beside the wall. Narrow (≤699px): the wall stops being worth compositing, so it is dropped entirely and the roster becomes the app — each row draws its own picture, a promoted feed expands to full width, and reorder gets ↑/↓ buttons because touch has neither drag-and-drop nor alt+arrow. `freeze` moves into the row too, so the watchdog can still be made to fire on a phone.
- **Shared walls, optional.** With Firebase configured the feed registry is live across every operator on the same database; without it the wall is private and local. The header states which.

## How liveness is measured

**Decoded frames, not presented frames.** The obvious approach is `requestVideoFrameCallback`, and it's wrong here: rVFC fires on frame *presentation*, and these decoders are offscreen — the wall is drawn from their textures, not from the elements. Every feed reported dead. `getVideoPlaybackQuality().totalVideoFrames` counts decoded frames regardless of presentation, so that's the heartbeat. The cost is exact per-frame timestamps, so the stat shown is decode interval, labelled as such.

**The watchdog owns its clock, in a Worker.** A liveness check on the main thread is a victim of the jank it's meant to detect: while the thread is blocked its timer doesn't fire either, and silence reads as health. The `long tasks` and `blocking` counters in the header are the main thread's own report card, measured with `PerformanceObserver` while the watchdog keeps its own time.

**Frame arrival alone is not enough.** When a live source dies, hls.js enters a reload loop — it retries the stalled playlist, each attempt decodes a frame or two, and `currentTime` resets each cycle. Frames keep arriving, so an arrival-only watchdog sits at "degraded" forever and never calls it, while the operator is shown the same few seconds on repeat. Observed directly: a feed dead for two minutes still producing frames every ~1.1s.

So liveness also requires **windowed media drift** — how far the media clock moves per second of wall clock, over the last six seconds. ~1.00 healthy; a reload loop replays the same window and collapses toward 0. A feed with frames arriving and drift below 0.35 is called stale, because to the operator it is.

### Two different failures, and why the log names which

The worker reports *which* condition fired, because the two need different responses and collapsing them throws away the only interesting part:

| Reason | What happened | How it reads |
|---|---|---|
| `frames` | Nothing is arriving at all. The easy case, and barely distinguishable from signal loss. | *signal lost — frames stopped arriving* |
| `drift` | Frames are arriving **at full rate** and the media clock has stopped. Every arrival-based indicator still reads healthy. | *frames stale — arriving at full rate, picture not advancing* |

The second is the one this project exists for. Measured on a frozen feed:

```
decode interval  66 ms      ← healthy cadence
decoded          225        ← still counting up
dropped          0
media drift      0.00       ← the media clock has stopped
pill             stale 0.0s ← zero seconds since the last frame, and dead
```

Every arrival-based indicator says healthy. Only drift catches it.

## Architecture

```
src/
  main.tsx            bootstrap: telemetry, global error traps, error boundary
  App.tsx             wall state: registry, roster, focus policy, incidents, escalations
  VideoWall.tsx       WebGL compositor — layout maths, tile meshes, upload budget
  useTile.ts          one decoder: hls.js attach, fault injection, frame heartbeat
  watchdog.worker.ts  the watchdog — owns its clock, decides liveness, names the reason
  types.ts            worker protocol + shared domain types
  feeds.ts            registry persistence, feed catalogue, and the pre-flight probe
  sync.ts             storage facade: localStorage by default, Firebase RTDB opt-in
  telemetry.ts        Sentry + GA4, both opt-in and code-split
  perf.ts             long-task / blocking-time observer
  ErrorBoundary.tsx   says the wall stopped rather than showing a blank page
```

Data flow for one feed:

```
hls.js ─▶ <video> (offscreen, 2px) ─▶ getVideoPlaybackQuality() poll
                    │                            │
                    │                            └─▶ frame heartbeat ─▶ Worker ─▶ liveness + reason
                    │                                                              │
                    └─▶ VideoTexture ─▶ WebGL quad          DOM overlay ◀───────────┘
                                          (picture)          (label, pill, stats)
```

The picture is WebGL; the chrome is a DOM box tracking the quad. Stacking is explicit (`z-index` on the overlay, `z` on the mesh) so a tile enlarged by roster hover is in front on **both** layers — otherwise the neighbour that happens to come later in the registry paints over it and takes the clicks with it.

## Focus view — not just layout

Selection drives budget, not presentation. An operator scans the wall and studies one feed, so the rest needn't cost full rate:

- the focused feed uploads its texture **every frame**; carousel tiles are rate-capped
- the focused feed requests full quality (`hls.currentLevel = -1`); the rest pin to the lowest rendition — and these sources genuinely have two renditions, so it bites

## Faults are real, never cosmetic

| Fault | What actually happens |
|---|---|
| `freeze` | `hls.stopLoad()`. The live buffer starves within seconds, then a reload loop. |
| `low-q` | Pins hls.js to its lowest rendition — real bitrate degradation. |

Available on a promoted tile, and on every row in list mode.

## Sources: real public CCTV, and what it took to find it

The wall opens on four **Caltrans highway cameras** — genuine public road CCTV, published as open HLS with CORS on playlist **and** segments:

| | |
|---|---|
| `I5-SR55` | NB I-5 at SR-55, Orange County — `wzmedia.dot.ca.gov/D12/NB5SR55.stream/...` |
| `I5-OSOPKWY` | NB I-5 at Oso Pkwy — `wzmedia.dot.ca.gov/D12/NB5OsoPkwy.stream/...` |
| `SR88-PINEGROVE` | EB SR-88 Pine Grove, Amador County — `wzmedia.dot.ca.gov/D10/...` |
| `D7-CCTV337` | District 7, Los Angeles metro — `wzmedia.dot.ca.gov/D7/CCTV-337.stream/...` |

Verified end-to-end before seeding: live (sliding window, no `ENDLIST`), CORS-clean on playlist and segments, and delivering **5–9× faster than real time with all four running at once** — the last being the part that actually decides whether a wall is possible.

Fixed cameras pointed at roads are the right material for this specific tool, and not because they look the part. **They are the hardest case for a human watching a wall**: the scene barely changes, so a frozen tile and a working one are visually identical until a car should have moved and didn't. Broadcast news, where a freeze is obvious in about a second, quietly makes the problem look easier than it is — the news channels are kept in a second group for contrast, and because they are multi-variant, which the focused-quality policy needs to have anything to switch between. All feeds here are third-party; this project does not own the content.

Labels are taken from the **stream path the operator publishes**, not from a third-party camera list. A tool whose selling point is attaching verified evidence should not open by guessing which intersection you are looking at.

### CORS and "is it live" are not sufficient tests

Arlington County VA also publishes its traffic cameras as open HLS, and they were the first choice: real municipal CCTV, live sliding window, CORS-clean on playlist and segments. They pass **every check this project's probe makes**, and they are unusable.

Measured 2026-08-05: the origin served a 10-second segment in ~14 seconds — **below real time, single stream, on an idle connection**. Playback can never reach the live edge, so all four tiles went stale within 90 seconds and stayed there. The browser console said `ERR_EMPTY_RESPONSE`, which reads like an outage and isn't one.

So the probe now has a known blind spot, stated rather than papered over: it verifies a feed is *reachable and live*, not that it is *deliverable fast enough to play*. The camera is kept in the catalogue, labelled, as the honest example — it is neither up nor down, which is exactly the territory this project is about. Throughput is the next thing worth probing: fetch one segment, compare download time against its `EXTINF` duration.

### A buffer setting that manufactured its own outages

The forward buffer was `maxBufferLength: 3` — deliberately small, so a stalled feed surfaces in seconds instead of coasting on buffered segments. That is three segments of headroom on the 1-second feeds it was tuned against, and **less than one segment** on a public traffic camera publishing 10-second segments. The player sat permanently at the live edge; any jitter in when the encoder published drained the buffer, playback stalled, and the watchdog dutifully reported signal loss.

The reports were true — frames really did stop — and the cause was this config, not the camera. Buffer headroom is now taken from the stream's own `EXT-X-TARGETDURATION` (two segments, floored at the original 3s), which is the setting the original intent actually implied. One camera still alarmed afterwards: `NB5CrownValley`, whose playlist genuinely stands still for ~14s at a time and then jumps two segments. That one is a true positive, so it stays in the catalogue as the feed that alarms with no fault injection at all — and out of the default wall, because a demo that cries wolf on first load teaches you to ignore it.

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

## When things break

Failure handling is itself a claim about honesty, so it is built to say what is actually true:

- **A render crash** is caught by an error boundary that states the wall stopped. It does not try to re-render the subtree: the decoders and the WebGL context went with it, and a half-recovered wall claiming to be live is worse than an honest dead one.
- **hls.js fatal errors** follow the library's own recovery ladder — reload on a network error, flush and recover on a media error — bounded to three attempts per class so a dead origin doesn't become an infinite retry loop chewing the thread it is supposed to be measuring. Two deliberate exclusions: it will not recover a feed the operator **froze** (`freeze` *is* a `stopLoad()`, and auto-restarting it would silently undo the injected fault), and it does not touch the watchdog — reconnecting is an attempt, not evidence of frames.
- **The watchdog worker dying** used to be invisible: every pill froze on its last claim and the wall kept looking healthy. It now reports and banners — *"every status below is the last thing it said, not the current truth."*
- **Unhandled rejections and raw `window` errors** are captured too, since they are invisible otherwise.

## Testing: two suites, two questions

Full reasoning in [ADR-0008](docs/adr/0008-hermetic-e2e-real-smoke.md).

**Unit (16 tests)** — pure logic only: layout geometry and the hover-emphasis clamp, the probe's verdicts, and the registry's fallbacks. `fetch` is stubbed and `localStorage` is a `Map`, so nothing touches a network. `probeFeed` gets the most attention because it has the most branching and every branch encodes something learned the hard way: VOD posing as live, masters advertising variants that 404, playlists that are CORS-clean while their segments are not.

**End-to-end (8 tests, hermetic)** — runs against `?mock=1`. This project's own documentation records these public CCTV origins rotting; a suite that goes red when a highway camera reboots is a suite people learn to ignore. Covers the frozen-but-arriving case, auto-promotion, ignore semantics, search and filter, hover stacking, keyboard reorder, escalation evidence, and the phone list mode.

**Production smoke (3 tests, every 6 hours)** — runs against the real deployment and asserts a real camera is advancing frames. Deliberately not a `curl` of index.html. Tolerance is deliberate: a single dead municipal camera is not an alert, *nothing* alive is.

**Floors are enforced at 85%** for lines and functions (`bunfig.toml`), so CI fails on a regression rather than letting coverage erode quietly. `main.tsx` is excluded as bootstrap, along with the test harness itself.

### The mock seam

`?mock=1` replaces the transport and nothing else. Feeds are canvas-backed, generated in the browser, and the frame heartbeat is emitted on the same channel a real decoder uses — so the worker clock, hysteresis, auto-promotion and incident log are all genuinely exercised offline.

Freezing a mock **does not stop its heartbeat**. Frames stopping is the easy case; the failure this project is named for is frames arriving at full rate while the media clock is stopped. So a frozen mock keeps delivering at full rate and keeps reporting the same media time, drift collapses, and the tile is caught at `stale 0.0s`. Anything else would be testing the easy path and calling it covered.

### CI

| Workflow | Trigger | What it gates |
|---|---|---|
| `ci.yml` | push / PR | Typecheck (strict, `noUnusedLocals`), tests + 85% coverage floors, production build |
| `e2e.yml` | push / PR | The hermetic Playwright suite against a real build |
| `smoke.yml` | every 6h + manual | Frames advancing on the live deployment |

## Deployment

Deployed on Railway, which detects the Vite app and serves the static build — no Dockerfile, no config:

```bash
railway up          # from the project directory; ships the working tree
```

The deploy is CLI-driven rather than git-connected, so pushing to GitHub does not redeploy. That is what the smoke test exists to catch in the other direction: the deployed thing decaying while the repo looks fine.

## Running it

```bash
bun install     # or npm install
bun run dev     # http://localhost:5183
```

No other setup — the feeds are public, and nothing needs configuring. Start with 1–2 feeds; each additional stream is a full decoder, and that is the real ceiling (see below).

Append `?mock=1` for synthetic canvas-backed feeds that need no network at all.

```bash
bun run typecheck        # strict, with noUnusedLocals
bun test src             # unit + component, with coverage floors enforced
bunx playwright test     # end-to-end, hermetic (?mock=1) — builds and serves the app
bun run test:smoke       # the deployed app: are real cameras advancing frames?
```

### Optional integrations

Everything below is off unless configured, and each is loaded with `import()` inside its own enable path so an unconfigured build never downloads the vendor SDK. A monitoring demo that cost 40kb of third-party JavaScript to watch four cameras would be arguing against itself. See [`.env.example`](.env.example).

| Set | Turns on |
|---|---|
| `VITE_FIREBASE_*` | **Shared wall** — the registry is live across every operator on the same database instead of one browser, because if one operator acknowledges a dead camera, everyone else needs to see it. Falls back to local on any Firebase failure: a shared wall that cannot reach its backend must degrade to a working private wall, never a blank screen. |
| `VITE_SENTRY_DSN` | Error reporting. Unset, errors go to the console and the UI still tells the operator when the watchdog worker has died. |
| `VITE_GA_ID` | Analytics, as a closed set of domain events (signal lost/restored, escalations, registrations) rather than a click tally. |

## Bugs worth recording

Three, all the same shape as the failure this project is about: something that reports a plausible number while measuring the wrong thing.

**A benchmark I threw away.** The first GPU-vs-DOM A/B looked decisive — GPU 60fps vs DOM 32fps at 4 feeds, GPU collapsing to 5.5fps at 24 — and I'd written a confident explanation about texture-upload bandwidth. Then two bugs surfaced: the scene was being rebuilt ~10×/second (status and stream identity shared one prop, so the layout effect tore down every mesh on each watchdog tick), and **the tiles were black the whole time** — plain `THREE.Texture` doesn't take three.js's video upload path, so no uploads were happening at all. I had measured the cost of uploading nothing and explained it with a theory about the cost of uploading. Both fixed; the numbers were deleted rather than corrected, because a measurement of the wrong thing doesn't become right when you adjust it.

**Every staleness figure was silently offset.** The worker compared its own `performance.now()` against timestamps taken on the main thread — and a Worker has its **own time origin**. Detection still fired, because the value grows without bound once frames stop, so it crossed the threshold anyway. But every number displayed was wrong by a constant. It surfaced as a negative reading: `stale for -2.6s`. Both sides now use `Date.now()`.

**The mock reproduced the thesis against itself.** Building the synthetic feeds, media time was derived from a *tick count* (`n / 15`) while the same loop pushed a React state update per frame per tile — 45 renders a second across three feeds, which starved the very interval it was counting. Media advanced at ~0.22× wall clock, so every mock feed sat permanently stale for a reason that was pure artifact of the harness. Media now comes from elapsed time and stats moved to the 400ms cadence the real path uses. Verified after: drift `1.00` healthy, decaying to `0.00` over the drift window once frozen.

## Honest limitations

**No compositor performance numbers are quoted anywhere.** See above. Re-measuring needs a quiet machine; on the development laptop, DOM's own 24-feed figure drifted from 30fps to 8.9fps between runs.

**Decode is the ceiling, and it's low.** Four concurrent 720p decodes saturated the dev machine — ~48 frames decoded in 18s with 16.9s of blocking time, and the watchdog correctly called every feed stale because frames genuinely weren't arriving. The production answer is a low-resolution sub-stream for wall tiles; the policy is wired, the sources only offer two renditions.

**The check this replaces is a realistic weak one**, not a straw man — `readyState >= 2 && !paused && !error`, a common shipped pattern. A stricter `readyState >= 3` would catch a plain buffer underrun. What defeats *every* readyState-based check is a frozen picture with an advancing clock, which is why frame advancement and media drift are the signals rather than a better threshold. `useTile` still computes that naive verdict alongside the real one; the side-by-side toggle that used to surface it has been taken off the control bar.

**Hysteresis, and why it exists.** A state must hold for 12 consecutive worker ticks before it counts as an event. Without it a feed under load flaps — the machine stalls a decode, the watchdog correctly calls it stale, it recovers, and the cycle repeats, producing a dozen lost/restored pairs in twenty seconds. Every individual reading was true and the sequence was still useless. Measured after: 0 incidents in 50s under 21s of blocking time, while a genuine freeze still produced exactly one lost/restored pair. The pill shows raw state immediately; only *events* require confirmation.

**List mode draws thumbnails from the decoders, and that relies on a trick.** The `<video>` elements are kept in the document at two pixels wide with near-zero opacity, because `display: none` stops decoding and reparenting them remounts the element and tears down the hls attachment. `drawImage` reads the decoded frame at its intrinsic size, so it does not care how small the source element is. Verified in Chromium; a browser that decides not to decode a near-invisible video would show black thumbnails while the liveness pills stayed correct, since those are measured from `getVideoPlaybackQuality()` rather than from anything drawn.

**Reordering on touch is buttons, not dragging.** HTML5 drag-and-drop does not fire for touch, and a pointer-events implementation is real work for a demo; the ↑/↓ controls do the same operation.

**Acknowledgements are session-scoped.** Ignoring a feed deliberately does not persist: an acknowledgement is about a shift, not a camera, and one that silently survives a reload is how a feed stays suppressed long after the person who suppressed it went home.

**Not built:** pixel-level frozen-frame detection (hash consecutive downsampled frames) for the advancing-clock case; culling off-screen tiles; throughput probing before a feed joins the wall.

## Decisions

Nine records under [`docs/adr/`](docs/adr/README.md), including the two that were corrected by evidence.

| # | Decision |
|---|---|
| [0001](docs/adr/0001-frames-not-connection.md) | Liveness means frames advancing, not connection state |
| [0002](docs/adr/0002-watchdog-in-a-worker.md) | The watchdog owns its clock, in a Worker |
| [0003](docs/adr/0003-drift-as-second-signal.md) | Frame arrival alone is insufficient — windowed media drift |
| [0004](docs/adr/0004-gpu-composited-wall.md) | One WebGL surface, not N video elements |
| [0005](docs/adr/0005-hysteresis-before-events.md) | Detection is instant, events are confirmed |
| [0006](docs/adr/0006-buffer-relative-to-segments.md) | Buffer headroom is relative to segment duration |
| [0007](docs/adr/0007-probe-cannot-prove-playable.md) | The probe verifies reachable-and-live, not deliverable |
| [0008](docs/adr/0008-hermetic-e2e-real-smoke.md) | Hermetic e2e on mocks; frame-aware smoke on production |
| [0009](docs/adr/0009-local-first-shared-optional.md) | Local by default, shared wall opt-in behind one facade |

## Stack

React 19 · TypeScript (strict) · Vite · three.js · hls.js · Web Workers · Playwright · Bun test · Firebase RTDB *(optional)* · Sentry *(optional)* · GA4 *(optional)* · Railway · GitHub Actions
