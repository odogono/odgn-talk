---
type: perf
scope: repo
---

Run the Zig Core's simple instructions (constants, locals, jumps, branches, Number comparisons and addition, subtraction and multiplication) through a fast path that charges the same Fuel at the same boundaries. A plain counting loop now runs about 5.5× faster, ahead of AppleScript (#1289).
