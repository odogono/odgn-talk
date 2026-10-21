---
type: perf
scope: repo
---
Lay out each lowered body's code as soon as the bodies before it are, rather than holding every body's working code to the end of the lowering (#1447). A Load of 100,000 empty Handlers now peaks at 51 times its source in the Zig reactor's linear memory instead of 76, and the Go adapter allocates 144 times the source instead of 289.
