---
type: perf
scope: ts
---
Reduce TS Core instruction overhead by reusing charging scratch space, popping operand stacks directly and privately owning immutable Value and Map data (#1580).
