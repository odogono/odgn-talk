---
type: feat
scope: repo
---
Add Libraries to the experimental Zig-backed Go adapter: CompileLibrary checks in Zig, and AddLibrary and ReplaceLibrary mirror each Library into every Group's guest. The Zig Core now binds nothing for unknown imports, checks Capability calls when a Library declares no Grants, refuses Joins in Libraries, and finishes a Library replacement after Grant release hooks (#1033, #1035).
