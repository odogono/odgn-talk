---
type: feat
scope: go
---
Add `WithMusicalClock`, a `GroupOption` that `NewGroup` and `Restore` take, so a Go Host with a Transport can let its Scripts `wait 8 bars`. Without it, a `wait` in a Musical Unit raises `no musical time` (ADR 0166, #2065).
