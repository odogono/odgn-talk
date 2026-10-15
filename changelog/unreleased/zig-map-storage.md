---
type: perf
---

Share ordered storage between large Zig Map versions, reducing copying during
construction and replacement while preserving immutable values, insertion order
and resource accounting. Keep small Maps flat and concentrate deletion inside
the value module.
