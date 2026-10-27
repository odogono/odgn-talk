---
type: perf
scope: ts
---

Cut TS Core Load time by about 15%, and LSP reanalysis by about 13%, by finding the checker's per-element records by source position, sharing unchanged control-flow contexts, building tokens without object spreads and caching recent code identities (#1586).
