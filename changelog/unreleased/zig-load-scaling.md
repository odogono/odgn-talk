---
type: perf
---
Reduce Zig Core load time and physical memory for large Scripts and Libraries by
indexing Handler exports and checker bodies, and releasing compiler working
storage after loading. Protect large loads with native and WASI regression checks
(#790).
