---
type: perf
scope: repo
---

Make Map writes on the Zig Core up to twice as fast by sharing keys between a Map's versions instead of copying them on every write (#1924).
