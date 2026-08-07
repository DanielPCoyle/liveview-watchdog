# One performance run is a measurement of the machine

## When this applies

Lighthouse, benchmarks, load tests, timing assertions — anything where the
number depends on available CPU.

## What broke

Three consecutive Lighthouse runs of an **unchanged page** scored 74, 94 and 82,
with Total Blocking Time between 290ms and 1,570ms. Lighthouse applies 4x CPU
throttling, which amplifies whatever else the machine is doing; a stray dev
server moved the score by 20 points.

An earlier benchmark in this repo was thrown away entirely for a related reason:
it measured the cost of uploading nothing and explained it with a theory about
the cost of uploading.

## Required actions

1. Run **at least three times and assert on the median**. `lighthouserc.json`
   does this with `aggregationMethod: median`.
2. Quiet the machine first: no dev servers, no test runners, nothing else
   competing.
3. When quoting a number, say what it describes. This project's scores describe a
   **cold load**; the same build with four cameras playing scores 36-41, and both
   are true.

## Verify before completion

Quote the spread, not just the best run. A single figure with no variance stated
is not a measurement.
