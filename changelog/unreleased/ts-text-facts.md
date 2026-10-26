---
type: perf
scope: ts
---
Cache Text measurements and Characters in the TS Core, and normalize concatenation only at the join, so building and reading text avoids repeated full-string scans.
