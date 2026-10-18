---
type: fix
scope: repo
---
Suspend and charge valid waits outside the Clock range on Zig, Go and TS without trapping or overflowing. Preserve exact timer order and earlier Timeout Blocks, and omit unrepresentable deadlines from Instant output (#1064, #1260, #1262). Zig saves use format `zig/13`; earlier layouts are refused. The Elixir package pins a matching reactor release.
