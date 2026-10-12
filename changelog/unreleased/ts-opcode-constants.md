---
type: perf
scope: ts
---
Reduce the TS Core's minified browser bundle by emitting inlineable opcode constants, saving about 0.6 KB gzip without changing the public API (#663).
