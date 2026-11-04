---
type: feat
scope: go
---
Add `DefineMusicalClock` and `WithMusicalClock`, a `GroupOption` that `NewGroup` and `Restore` take, so a Go Host with a Transport can let its Scripts `wait 8 bars`. Without one, a `wait` in a Musical Unit raises `no musical time` (ADR 0166, #2065).
