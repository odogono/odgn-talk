---
type: fix
scope: zig
---
The Zig Core's Inspect now leaves `calls` out for a suspended Run that waits on nothing, as the TS Core does.
