# A gate you have not seen fail is not a gate

## When this applies

Any time you add or change something whose job is to **fail the build**:
coverage thresholds, lint rules, Lighthouse budgets, type strictness, a CI
assertion, a required check.

## What broke

`bunfig.toml` was configured with `coverageThreshold = { lines = 0.85 }` and the
change was committed, pushed, and described in the README as an enforced floor.
It enforced nothing usable, for three separate reasons discovered only by
deliberately testing it:

- bun applies the threshold **per file**, not to the total. A 93% average passed
  while two files sat below the line.
- An **omitted metric is treated as 100%**, so specifying only `lines` demanded
  perfect function coverage and failed everything — while reading as valid.
- The singular key `line` is **silently ignored**: no error, no enforcement.

CI never caught it because the runners were queued for hours. It would have
surfaced as a red build on someone else's branch.

## Required actions

1. After configuring a gate, **make it fail on purpose**. Raise the threshold
   past current values, run it, confirm non-zero exit. Restore.
2. Confirm the **scope**: per-file or aggregate? Which files are excluded, and
   is that exclusion deliberate and stated?
3. Prefer a config the tool validates. If an unknown key is accepted silently,
   assume any key might be.

## Verify before completion

State the observed exit codes both ways — passing at the configured floor, and
failing above it. "The gate is configured" is not the claim; "the gate was seen
to fail" is.
