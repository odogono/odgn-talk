---
type: perf
scope: repo
---
Let the experimental Go Zig adapter keep compiled guest code between processes in the directory `NORTHTALK_ZIG_CACHE_DIR` names: with a warm cache the first Group of a process takes about 22 ms instead of 0.67 s on an Apple M5 (#1103).
