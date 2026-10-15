---
type: perf
scope: ts
---
Reuse immutable Unit metadata and static conversion targets in the TS Core,
reducing repeated Quantity conversion work while preserving per-factor rounding
and Script accounting (#941).
