---
type: perf
scope: repo
---
Cut a Zig Load's peak memory for sources with many Handlers. Loading 100,000 empty Handlers now peaks at about 81 times the source, down from 181, and keeps about 27 times, down from 33. Large load-time tables get exact allocations instead of growing inside arenas, the checker frees each body's working storage as the body finishes, and the lowering frees each body's working code once it's copied into the unit (#1411).
