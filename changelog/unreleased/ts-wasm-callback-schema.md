---
type: perf
scope: ts
---

Decode each binary WASM callback Value once, and encode callback results directly from the answer, so binary callbacks are faster than JSON callbacks under both Bun and Node (#1318).
