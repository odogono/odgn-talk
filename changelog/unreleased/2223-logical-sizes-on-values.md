---
type: perf
scope: ts
---

Make collection-heavy Runs faster by caching each Value's logical size on the Value itself rather than in WeakMaps, and by counting map keys' UTF-8 bytes without encoding them.
