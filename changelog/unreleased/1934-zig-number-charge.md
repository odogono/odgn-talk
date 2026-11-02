---
type: perf
scope: repo
---

Make arithmetic loops on the Zig Core up to 8% faster by charging each result's Fuel from its Number directly, instead of building a temporary Value to measure it (#1934).
