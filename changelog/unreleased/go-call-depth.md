---
type: perf
---
Track the Go Core's real call depth incrementally, avoiding repeated frame scans
and allocations during deep recursion while preserving depth limit accounting
through recovery and cancellation (#506).
