---
type: fix
scope: corpus
---
Use a cancellable Request in `counters/faults-and-cleanup`, enabling full Go replay, and reject TS Trace replay cancellation without a Request, Decision or Host call context (#364).
