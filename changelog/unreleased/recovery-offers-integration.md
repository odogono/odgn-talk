---
type: feat
scope: spec
breaking: true
---
Integrate Recovery Offers and two-phase catch search across both Cores, save/restore, sessions, debugger and Playground (ADR 0060, #392). `offer` is now reserved: rename identifiers and quote map keys with that spelling. Ordinary catch tests run before cleanup, and Error Fuel follows the revised provisional Cost Model 0; language remains 1.0-rc.2. Go dispatch snapshots use private format `go/2`; prior `go/1` saves are refused.
