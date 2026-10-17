---
type: fix
scope: repo
---
Keep Zig Core polling saves from growing with every issued Operation call by compacting call-id eligibility into ranges. Saves now use `zig/10`; older Zig save layouts are refused (#1124).
