---
type: perf
scope: repo
---
Cut the Zig Core's per-Request guest work by about a quarter, and the Go adapter's allocations by about a seventh. Pumps no longer fill a block-sort cache, format ids through `std.fmt`, format the Pump clock without a Trace, write binary replies byte by byte or copy them again at the export. Idle inline polls cross into the Host twice instead of four times and skip JSON parsing. The adapter reuses its reserved input buffer, encodes small integers directly and builds a Pump's refusal fields only when refused (#1267).
