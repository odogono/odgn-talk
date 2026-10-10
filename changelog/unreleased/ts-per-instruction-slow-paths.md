---
type: perf
scope: ts
---
Speed up the TS Core's instruction loop: exact decimal results skip rounding and re-parsing, a Map key write shares the Map's other pairs instead of re-freezing them, and shallow calls skip the depth recount. `core/fib` runs about 69% faster, `core/calls` 57% and `collections/map-build` 48%.
