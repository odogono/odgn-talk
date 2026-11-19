---
type: perf
scope: ts
---
Build the TS Group's Run reports by assigning fields instead of spreading objects, making `messaging/sends`, `messaging/parents` and `messaging/joins` about 10–12% faster on Bun (#2235).
