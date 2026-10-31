---
type: perf
scope: ts
---
Skip rendering Host delivery Trace lines when the Group has no `trace` sink, and remember Values already found to reach no Function, so delivering a large unchanged argument each tick costs far less (#1857).
