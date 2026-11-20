---
type: fix
scope: zig
---

The Zig Core's Group gives the Libraries it holds through `talk_libraries` and the reactor's `libraries` message, and its Session Host restores with them, so `:restore` straight after `:save` no longer refuses as `save mismatch` when a `:library replace` recompiled a Library that imports the replaced one (#2349).
