---
type: perf
---
Reduce Go Core execution allocations by reusing trial and call-frame buffers,
resolving instruction metadata once, and using checked integer fast paths for
decimal arithmetic and cost calculations. Preserve Fuel, decimal precision and
charge-before-commit behavior (#322).
