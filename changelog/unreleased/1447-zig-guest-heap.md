---
type: perf
scope: repo
---
Cut the Zig reactor's linear memory for large Loads (#1447). A guest heap gives large blocks exact page runs, merges freed runs and grows blocks in place, and the lowering lays out each body's code as soon as it can rather than holding every body's working code to the end. A Load of 100,000 empty Handlers peaks at 51 times its source in linear memory instead of 104, and the Go adapter allocates 144 times the source instead of 289.
