# Architecture Decision Records

Each record is one decision: what was chosen, what it was chosen *over*, and
what it costs. They exist because the interesting part of this project is not
the code — it is the set of judgement calls behind it, several of which were
made twice because the first measurement was wrong.

Where a decision was reversed or corrected by evidence, the record says so.
That is the point of keeping them.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-frames-not-connection.md) | Liveness means frames advancing, not connection state | Accepted |
| [0002](0002-watchdog-in-a-worker.md) | The watchdog owns its clock, in a Worker | Accepted |
| [0003](0003-drift-as-second-signal.md) | Frame arrival alone is insufficient — windowed media drift | Accepted |
| [0004](0004-gpu-composited-wall.md) | One WebGL surface, not N video elements | Accepted |
| [0005](0005-hysteresis-before-events.md) | Detection is instant, events are confirmed | Accepted |
| [0006](0006-buffer-relative-to-segments.md) | Buffer headroom is relative to segment duration | Accepted — corrects an earlier bug |
| [0007](0007-probe-cannot-prove-playable.md) | The feed probe verifies reachable-and-live, not deliverable | Accepted with a known gap |
| [0008](0008-hermetic-e2e-real-smoke.md) | Hermetic e2e on mocks; frame-aware smoke on production | Accepted |
| [0009](0009-local-first-shared-optional.md) | Local by default, shared wall opt-in behind one facade | Accepted |
