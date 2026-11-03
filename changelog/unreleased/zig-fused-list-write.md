---
type: perf
scope: repo
---
Run `load; load; load; chunk-set item; store` as one step with one Fuel charge on the Zig Core's fast path, with Fuel and the Trace unchanged, making `collections/list-update` about 35% faster (#2022).
