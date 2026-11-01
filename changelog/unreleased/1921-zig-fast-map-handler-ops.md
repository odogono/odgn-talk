---
type: perf
scope: repo
---

Make Map updates, Handler calls and `repeat for each` loops on the Zig Core 15–36% faster by running them on the run loop's fast path (#1921).
