---
type: perf
scope: ts
---

Run simple TS Core instructions through a fast path, with small integers kept as JS numbers, so `core/loop` runs about 7× faster with unchanged Fuel and allocation (#1297).
