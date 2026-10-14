---
type: perf
---
Avoid big-integer scratch allocation for terminating Decimal division and
integer `div`/`mod` in the Zig Core, and apply pre-parsed Unit factors
without re-reading their text, preserving Decimal precision, trailing zeros
and per-step Unit conversion rounding (#923).
