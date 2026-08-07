# Rules

Standing instructions, each written from an incident that actually happened in
this repository. A rule earns its place by naming the failure that produced it —
if it cannot cite one, it is a preference, not a rule.

Every rule states: **when it applies**, **what broke**, **what to do**, and
**what to verify before claiming completion**.

| Rule | Born from |
|---|---|
| [verify-the-gate](verify-the-gate.md) | A coverage gate that reported 85% enforcement and enforced nothing |
| [test-runtime-parity](test-runtime-parity.md) | 31 tests that passed locally and failed CI on module evaluation order |
| [verify-instrumentation-on-the-wire](verify-instrumentation-on-the-wire.md) | Analytics events that queued perfectly and never transmitted |
| [deferred-initialisation](deferred-initialisation.md) | Deferring the worker silently broke feed registration |
| [measure-medians](measure-medians.md) | Lighthouse scoring 74 and 94 on the same unchanged page |
| [the-harness-can-lie](the-harness-can-lie.md) | A mock that made every feed look stale for a reason it invented itself |
