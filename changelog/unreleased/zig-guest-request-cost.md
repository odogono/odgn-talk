---
type: perf
scope: repo
---
Cut the Zig Core's per-Request guest work by about a quarter: Pumps no longer fill a block-sort cache, format ids through `std.fmt`, format the Pump clock without a Trace, write binary replies byte by byte or copy them again at the export, and idle inline polls cross into the Host twice instead of four times and skip JSON parsing (#1267).
