---
type: perf
---
Avoid big-integer scratch allocation for common exact addition, subtraction and
multiplication in the Zig Core, preserving Decimal precision and trailing zeros
(#877).
