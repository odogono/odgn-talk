---
type: feat
scope: zig
---
The WASI reactor serves the Zig Session Host as `session-v1`, so an embedder can run a whole session through the reactor's messages while keeping its own terminal, files, Clock and Host Objects (#2277).
