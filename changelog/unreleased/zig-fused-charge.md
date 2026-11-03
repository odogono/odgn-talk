---
type: perf
scope: repo
---
Run `load; load | const; <arithmetic | comparison>; store | branch` on Numbers as one step with one Fuel charge on the Zig Core's fast path, with Fuel and the Trace unchanged, making `core/loop` about 30% faster and `numbers/add` and `numbers/divide` 14–21% faster (#1931).
