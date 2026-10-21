---
type: perf
scope: repo
---
Free the Zig checker's own lookup tables when the check ends, so the lowering holds only what it reads of the check (#1461). A native Load of 20,000 empty Handlers now peaks at 57 times its source instead of 76, and a Load of 100,000 peaks at 47 times its source in the Zig reactor's linear memory instead of 51.
