---
type: perf
scope: ts
---

Read a Library's exports from its declaration headers without converting its bodies, making the LSP's edit-and-reanalyse cycle about 9× faster (#2221).
