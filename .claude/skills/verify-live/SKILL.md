---
name: verify-live
description: Prove the wall actually works, from pure logic up to real cameras in production, refusing to report success without a terminal observation at each layer. Use when the user says "verify", "is it working", "check production", "did that deploy work", or before claiming any change is done.
---

# verify-live

This project's thesis applied to its own verification: **a green light you have
not observed is not evidence.** Each layer below answers a different question,
and a pass at one layer says nothing about the next.

## Run the layers in order

```bash
bun run typecheck        # 1. does it still type? (strict, noUnusedLocals)
bun test src             # 2. pure logic + components, per-file coverage floors
bunx playwright test     # 3. hermetic e2e on ?mock=1 synthetic feeds
bun run test:smoke       # 4. the DEPLOYED app: are real cameras advancing frames?
```

Stop at the first failure and report it. Do not run a later layer to "see if it
passes anyway" — the earlier failure is the finding.

## What each layer can and cannot tell you

| Layer | Proves | Does NOT prove |
|---|---|---|
| typecheck | Nothing dangles after a removal | Any behaviour |
| unit | Worker verdicts, probe verdicts, registry fallbacks, component contracts | Ordering between components |
| e2e (mock) | The wall's behaviour end to end, offline and deterministic | That real HLS still works |
| smoke (prod) | Real cameras are advancing frames right now | That the code you just wrote is deployed |

That last cell matters: **the deploy is CLI-driven from the working tree**, not
from git. A green smoke test proves the *deployed* build is healthy, which may
not be the build you just committed. If the change needs to be live, run
`railway up` and re-run the smoke test after.

## Reporting rules

- Quote the observation, not the intention: exit codes, counts, the `[smoke]
  feed states:` line.
- If a layer could not be run, say which, why, and what is therefore unverified.
- Never write "should work". Either it was observed or it was not.
