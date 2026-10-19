---
type: perf
scope: ts
---
Speed up Text Pattern searches by reusing matcher scratch storage, reducing thread allocation and freezing Match map pairs only once (#1294).
