---
type: perf
scope: repo
---
Cut Zig Load memory for large sources: one line index shared by parsing, checking and lowering, one token per run of line ends, and doubling guest memory growth in the Go adapter (#1403).
