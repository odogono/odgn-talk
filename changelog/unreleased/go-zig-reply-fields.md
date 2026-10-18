---
type: perf
scope: repo
---
Reduce the experimental Go Zig adapter's reply-decoding allocations by reading struct fields directly from JSON spans (#1103).
