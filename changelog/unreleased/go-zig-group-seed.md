---
type: fix
scope: repo
---
Honor `GroupOptions.Seed` in the Go Zig adapter, including the full `uint64` range, so seeded random draws match native Go and continue across Save/Restore (#1285).
