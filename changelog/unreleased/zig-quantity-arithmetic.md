---
type: perf
scope: repo
---
Run Zig Quantity arithmetic, numeric division and static Unit conversions
through the instruction fast path, preserving rounding, Fuel and logical
allocation (#1290).

Avoid wide division for coefficient-one divisors and reduce Unit conversion
and Quantity construction overhead.
