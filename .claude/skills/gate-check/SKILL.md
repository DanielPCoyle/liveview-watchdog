---
name: gate-check
description: Prove a quality gate actually fails when it should - coverage floors, Lighthouse budgets, lint rules, CI assertions. Use when adding or changing any gate, or when the user asks whether a threshold is really enforced.
---

# gate-check

A gate nobody has watched fail is decoration. This repository shipped a coverage
threshold that reported an 85% floor and enforced nothing — see
[verify-the-gate](../../rules/verify-the-gate.md).

## Procedure

1. **Establish the current value.** Run the gate and record the real numbers.
2. **Confirm it passes at the configured floor** — exit code 0.
3. **Raise the floor past the current value**, re-run, and confirm a **non-zero
   exit**. This is the step that matters; everything else is inference.
4. **Restore** the configuration and confirm exit 0 again.
5. **Establish the scope.** Per-file or aggregate? What is excluded, and is each
   exclusion deliberate and documented where it is configured?

## Known traps in this repo

- `bun` applies `coverageThreshold` **per file**, not to the total.
- An **omitted metric is treated as 100%**; both `lines` and `functions` must be
  stated or the gate fails everything.
- The singular key `line` is **accepted and ignored**. Silent no-ops are the
  default failure mode, so assume any unknown key is one.
- Lighthouse scores swing ~20 points with machine load. Gate on the **median of
  three** (`lighthouserc.json`), never a single run.

## Report

Both exit codes, the value that triggered the failure, and the scope. "It is
configured" is not the finding; "it was seen to fail at X" is.
