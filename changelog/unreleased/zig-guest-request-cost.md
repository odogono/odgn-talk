---
type: perf
scope: repo
---
Cut the Zig Core's per-Request guest work by about a fifth: Pumps no longer fill a block-sort cache, format ids through `std.fmt`, format the Pump clock without a Trace, or write binary replies byte by byte (#1267).
