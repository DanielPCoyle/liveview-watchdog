# The test harness can measure the wrong thing too

## When this applies

Building or changing a mock, fixture, synthetic data source, or any stand-in
that produces the signal under test.

## What broke

The `?mock=1` synthetic feeds derived media time from a **tick count**
(`n / 15`), while the same loop pushed a React state update per frame per tile —
45 renders a second across three feeds, which starved the very interval it was
counting. Media advanced at roughly 0.22x wall clock, so every mock feed sat
permanently stale for a reason the harness had invented.

The app was correct. The measurement was not. That is the exact failure this
project exists to detect, reproduced against itself.

## Required actions

1. Derive synthetic time from **elapsed wall clock**, never from an assumed
   timer cadence.
2. Keep the harness cheap. If producing the signal costs enough to disturb the
   thing being measured, the measurement is about the harness.
3. When a mock reports a failure, confirm the failure exists **without** the
   mock before acting on it.

## Verify before completion

Show the healthy baseline as well as the failure: a mock that only ever produces
the failing state has not demonstrated it can tell the difference.
