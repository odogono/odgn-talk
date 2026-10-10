---
type: perf
---
Speed up the Go Core's instruction loop: Cost Model formulas are parsed once rather than on every charge, instructions stop allocating closures and results on the heap, and a Map key write no longer rebuilds the whole Map. `core/fib` runs about 34% faster with 84% fewer host allocations, and `collections/map-build` about 71% faster.
