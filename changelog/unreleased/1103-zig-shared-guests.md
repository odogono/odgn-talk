---
type: perf
scope: repo
---
Let the experimental Go Zig adapter's Groups share a pool of guests per Core through `group-exchanges-v1`, instead of instantiating a guest each: on an Apple M5 a new Group with one Script takes about 29 µs instead of 94 µs and retains about 88 KB of heap instead of 2.4 MB (#1103).
