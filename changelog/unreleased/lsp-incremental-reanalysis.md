---
type: perf
scope: tools
---

Make LSP reanalysis after an edit about 4× faster on Bun by reusing each document's parse, check, lints and loaded unit until its text or the export summaries of the Libraries it imports change (#1597).
