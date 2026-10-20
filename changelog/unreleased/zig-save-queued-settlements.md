---
type: fix
scope: repo
---

Restore a Zig save taken before a restored Group's first Pump with its queued settlements, instead of refusing it as `invalid save`. The Zig save format is now `zig/16` (#1055).
