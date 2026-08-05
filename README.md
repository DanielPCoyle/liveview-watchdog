# Liveview Watchdog

**A tile is only *live* if frames are advancing. Connection state is not liveness.**

A multi-camera live-video wall that can tell a live feed from a dead one, and prove it — with a watchdog that runs off the main thread, real live HLS sources, and fault injection at the encoder rather than in the UI.

---

## The problem

In a live-video product the catastrophic failure isn't a crash. It's a tile that **looks** live and isn't: the element reports healthy, nothing throws, no error event fires — and the picture on screen is thirty seconds old. An operator trusts it. Nothing pages anyone, because nothing is broken; it's just absent.

Most dashboards answer *"is it connected?"* That's a proxy. This answers *"are frames still arriving?"*, which is the actual question.

## Demonstrated result

Four live cameras. `scripts/cameras.sh freeze 1` sends **SIGSTOP to camera 1's encoder** — the camera genuinely stops producing segments. Measured 12 seconds later:

| | cam1 (encoder stopped) | cam2–4 (healthy) |
|---|---|---|
| Frame-aware watchdog | **`stale 28.2s`** | `live` |
| Naive connection check | **`connected`** | `connected` |
| `video.currentTime` | 182.96 — **30s behind** | 213.9 |
| `video.error` | `null` | `null` |
| media-clock drift | 1.00 | 1.00 |

The connection check reports a healthy feed thirty seconds after the camera stopped sending.

## How it works

**Liveness is measured, not assumed.** `requestVideoFrameCallback` gives per-presented-frame metadata. Each frame emits a heartbeat; a tile is `live` only while heartbeats keep arriving.

**The watchdog owns its own clock, in a Worker.** This is the part that matters. A liveness check on the main thread is a victim of the very jank it's meant to detect — while the thread is blocked, its timer doesn't fire either, so silence gets read as health. The worker's timer keeps running regardless. Hit **inject main-thread jank** and watch the difference.

**Media-clock drift** compares media time against wall clock. Healthy ≈ 1.00; a frozen feed trends to 0. It catches the case where a feed stalls without ever firing an error.

**Faults are real, never cosmetic:**

| Fault | What actually happens |
|---|---|
| `cameras.sh freeze N` | SIGSTOP the encoder — the camera stops sending. The truest failure in the set. |
| `freeze` (per-tile) | `hls.stopLoad()` — client stops fetching; with a 3s live buffer it starves in seconds. |
| `jank` | A genuine main-thread busy-loop. Real long tasks, real dropped frames. |
| `low-q` | Pins hls.js to its lowest rendition — real bitrate degradation. |

## Sources are genuinely live — and that mattered

`scripts/cameras.sh` generates local live HLS with ffmpeg: 1s segments, a 4-segment sliding window, no `EXT-X-ENDLIST`, and a **wall-clock timecode burned into the picture** so a stale tile is visible to the eye, not only to the instrumentation.

This started out pointed at the usual public "test streams." Those are **VOD**. hls.js buffers a VOD asset end-to-end — `buffered` came back as `[10, 300]`, 208 seconds ahead — so `stopLoad()` did nothing, the player never starved, and none of the live-edge behaviour this project is about could occur. It was a demo of the wrong thing. Generating real live sources fixed it and made the repo self-contained.

## Running it

```bash
bun install          # or npm install
./scripts/cameras.sh start 4
bun run dev          # http://localhost:5183
```

```bash
./scripts/cameras.sh freeze 2   # kill camera 2 at the encoder
./scripts/cameras.sh thaw 2
./scripts/cameras.sh status
./scripts/cameras.sh stop
```

Requires `ffmpeg` (`brew install ffmpeg`).

## Honest limitations

**Frame-timing numbers must be gathered on a real display.** Verifying this in headless Chromium, `requestAnimationFrame` itself ran at a **1015ms median** — the compositor is throttled to ~1Hz with no vsync, so rVFC faithfully reports presentation that simply isn't happening at video rate. The instrumentation is correct; the environment is degenerate. Interval percentiles collected headlessly are meaningless. Decode counts, dropped frames, and drift are unaffected, which is why the liveness result above is trustworthy.

**The naive check modelled here is a realistic weak one**, not a straw man — `readyState >= 2 && !paused && !error`, which is a very common shipped pattern. Be precise about what it does and doesn't miss: in the SIGSTOP run above `readyState` fell to 2, so a stricter `readyState >= 3` check *would* have caught that particular stall. The failure that defeats **every** readyState-based check is a frozen picture with an advancing clock — an encoder repeating its last frame, or a CDN serving a stale segment on loop. That's why frame advancement and media drift are the right signals rather than a better readyState threshold.

**Not yet built:** pixel-level frozen-frame detection (hash consecutive downsampled frames to catch the advancing-clock case above); canvas/WebGL compositing to push past the ~16-tile point where individual `<video>` elements stop scaling; adaptive shedding of off-screen tiles.

## Stack

React 19 · TypeScript · Vite · hls.js · Web Workers · ffmpeg

No dependencies beyond hls.js and React. The watchdog, metrics, and fault injection are all first-party.
