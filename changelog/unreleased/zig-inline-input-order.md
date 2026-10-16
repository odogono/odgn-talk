---
type: fix
scope: repo
---
Preserve native Go input ordering in the experimental Zig adapter for synchronous
Trace sinks and concurrent inputs during exports. Add the opt-in Message Layer
`inline-inputs-v1` transport and cancel suspended Zig Calls before Grant release
hooks (#1051, #1075).
