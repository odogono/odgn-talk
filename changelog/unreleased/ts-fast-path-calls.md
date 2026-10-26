---
type: perf
scope: ts
---
Run TS Core iteration, key reads, appends, function calls and returns on the fast path, and step many instructions per Group callback, cutting `core/fib` and `core/calls` Run time by roughly 35–45% on Bun (#1585).
