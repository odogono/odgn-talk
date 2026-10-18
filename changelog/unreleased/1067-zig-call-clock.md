---
type: fix
scope: repo
---
Preserve pending Zig Calls' Segment identity and original Clock across later Pumps, Save/Restore and adoption, while Reissue reads the new Pump Clock. Save format `zig/12` rejects older Zig saves with `invalid save`, including under VariablesOnly; drain existing Groups on their old runtime or start fresh Groups (#1067).
