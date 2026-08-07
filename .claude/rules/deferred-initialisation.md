# Deferring creation breaks anything that assumed the old timing

## When this applies

Moving work later: lazy-loading a module, gating setup behind a user gesture,
replacing an eager import with a dynamic one, or adding a start/ready state.

## What broke

The watchdog worker was moved from "created on mount" to "created when the wall
starts". The effect registering feeds with it was keyed only on the feed list,
so it never re-ran once the worker appeared. Nothing was ever registered, and
every feed sat at `idle` forever — a wall that renders perfectly and measures
nothing.

The unit tests missed it because they start pre-authorised, so the worker existed
at mount as before. The end-to-end suite caught it.

The same change also broke fault application: `hlsRef.current` was populated
asynchronously, so a feed mounted already frozen never had the fault applied.

## Required actions

1. After deferring anything, **grep every effect, ref and callback that touched
   it** and ask what it now assumes about ordering. Dependency arrays keyed on
   the old trigger are the specific hazard.
2. Add an explicit readiness signal and depend on it, rather than relying on
   creation happening before consumption.
3. Exercise the **cold path** — first visit, nothing cached, nothing
   pre-authorised — not just the path the tests set up.

## Verify before completion

Run the end-to-end suite, not only the unit suite: this class of bug lives in
the ordering between components and is invisible to a test that constructs the
finished state directly.
