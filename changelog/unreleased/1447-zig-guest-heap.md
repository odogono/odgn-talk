---
type: perf
scope: repo
---
Cut the Zig reactor's linear memory with a guest heap that gives large blocks exact page runs, merges freed runs and grows blocks in place (#1447). A Load of 100,000 empty Handlers peaks at 76 times its source instead of 104, and the Go adapter allocates 14.5 times a blank 1 MiB source instead of 32.5.
