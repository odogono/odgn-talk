---
type: perf
scope: repo
---

Make function calls on the Zig Core about a third faster, and recursive calls about 40% faster, by running calls and returns within a Script on the run loop's fast path (#1914).
