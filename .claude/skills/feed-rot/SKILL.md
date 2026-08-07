---
name: feed-rot
description: Check whether the seeded public cameras are still alive and still deliverable, and propose replacements for any that have decayed. Use when the smoke test fails, when tiles show idle or stale in production, or on a periodic check of the catalogue.
---

# feed-rot

The seeded cameras are third-party municipal CCTV. They get decommissioned,
re-pathed, and rate-limited without notice, and when that happens **nothing
about the app changes** — the deployed demo simply becomes a wall of dead tiles.
This is the decay the scheduled smoke test exists to catch.

## Procedure

1. **Read the current state from production**, not from the source. Load the
   deployed wall, start it, and record each feed's pill after ~60 seconds. HLS
   with ~10s segments needs real time to reach the live edge.
2. **For every feed that is not live**, run `/probe-feed` against its URL to
   separate the causes:
   - gone (404 / DNS) → replace
   - VOD now → replace
   - CORS revoked → replace
   - **live and CORS-clean but slower than real time** → the Arlington case;
     it is neither up nor down, and it must leave the default wall
   - transient → re-check before touching anything
3. **Distinguish a dead camera from a broken app.** If *every* feed is dead,
   suspect the app or the network before the cameras. If one is dead, it is
   almost certainly the camera.
4. **Propose replacements** from the same operator where possible, verified with
   `/probe-feed` including the concurrent-throughput step.

## Rules for the fix

- Never seed a camera that alarms on its own. `NB5CrownValley` genuinely stops
  publishing for ~14s at a time; it belongs in the catalogue as the honest
  example, not on the default wall. A demo that cries wolf on first load teaches
  people to ignore it.
- Update the measurement date in the catalogue `note` when re-verifying.
- Update the README's source table in the same change.
