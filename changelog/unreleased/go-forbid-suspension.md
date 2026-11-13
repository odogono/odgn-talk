---
type: feat
scope: go
---

The embedded Zig Core is `reactor-v0.26.0`, so `LoadOptions.ForbidSuspension` refuses any possible Suspension Point in a Script as `can't suspend here`, and `ScriptView.ForbidSuspension` reports it.
