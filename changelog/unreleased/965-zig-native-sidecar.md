---
type: feat
---
Use Zig for the native Message Layer sidecar, sharing the WASI dispatcher and paused Host Inputs. Retire the Go sidecar and its private adapter; Elixir Port and Linux containment builds now need only Zig. Start fresh Groups from source and Host-owned data when moving from Go saves; no cross-Core converter is supplied. The public Go Core remains (ADR 0090, #965).
