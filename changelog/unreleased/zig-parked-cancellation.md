---
type: fix
scope: repo
---
Run dispatch-local cleanup when cancelling a parked queued Zig Run, preserving committed state and keeping later queued Runs parked until the active Run ends (#1063).
