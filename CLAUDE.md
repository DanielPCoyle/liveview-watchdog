# Project rules — Liveview Watchdog

This project is about the difference between a signal and a claim: a video tile
can report healthy while showing a thirty-second-old picture. The same standard
applies to work done on it. Nothing here is "done" because it looks done.

## Verify before committing

Run the smallest relevant set, and run it — do not report a suite as passing
unless it was executed.

| Change | Run |
|---|---|
| Any source change | `bun run typecheck` |
| Logic, components, worker | `bun test src` |
| Anything touching the wall's behaviour | `bunx playwright test` |
| Anything user-facing, before calling it shipped | `bun run test:smoke` |
| Bundle, loading, or render-loop changes | `bunx @lhci/cli autorun` |

`/verify-live` runs the ladder in order and reports what each layer does and does
not prove.

If a command could not be run, state which, why, and what is therefore
unverified. Never commit a known failing test without saying so explicitly.

## Claims require observations

- A gate that has not been seen to fail is not a gate. See
  [`.claude/rules/verify-the-gate.md`](.claude/rules/verify-the-gate.md).
- Instrumentation is verified on the network, never in the queue.
- "Passes locally" is a claim about your machine — check the runtime version.
- A single performance run measures the machine. Quote medians and spread.
- **Green CI is not a deployed change.** This project deploys from the working
  tree via `railway up`, not from git. A passing smoke test proves the *deployed*
  build is healthy, which may not be the committed one.

## Every incident becomes a rule

When a task exposes a bug, a wrong assumption, a failed approach or a rabbit
hole, write it into `.claude/rules/` before closing the task:

1. Name the incident — what actually broke, concretely.
2. Extract the underlying cause, not the symptom.
3. State when the rule applies, what to do, and what to verify.
4. Update an existing rule rather than adding a near-duplicate.

If a task produced no real lesson, say so. Do not write filler rules.

## Honesty in documentation

The README's value is that it records mistakes: a benchmark thrown away, a CORS
verdict that was wrong, a buffer setting that manufactured its own outages. That
is the standard.

- Never quietly drop an inconvenient measurement. State it with its caveat — the
  Lighthouse scores describe a cold load, and a running wall scores 36-41.
- Numbers in prose rot fastest. When coverage, scores or counts change, update
  the prose in the same change. `drift-checker` sweeps for this.
- ADRs record the reasoning at the time. If an implementation detail changed, add
  a note; do not rewrite the rationale.

## Feeds

- Never seed a camera that alarms on its own, and never one slower than real
  time. `/probe-feed` before anything joins the catalogue.
- Label cameras from the operator's own stream path. Do not guess a location.
- Record the measurement date. These endpoints rot, and `/feed-rot` exists to
  catch it.

## Secrets and configuration

- `VITE_*` variables are **build-time and public** — they are inlined into the
  browser bundle. Only ever put publishable identifiers there (a GA measurement
  ID, a Sentry DSN). Setting one on the running service without rebuilding does
  nothing.
- Update `.env.example` and the README whenever configuration changes.
- Every integration is opt-in and code-split; an unconfigured build must
  download no vendor SDK at all.

## Git

- Do not commit to `main` without being asked; branch for independent work.
- Keep commits narrowly scoped, and write the message for someone reading it in a
  year — including what broke and why the fix is shaped the way it is.
- Include the approximate token count as a trailer above `Co-Authored-By`.
