---
type: perf
---

Make appending to a Go Core List copy its storage once per 32 items instead of on every append. Growing a List of `nothing` to the conformance-minimum Allocation Budget through the WASI reactor drops from 66s to 23s, and its peak linear memory from 6.3× to 4.0× the budget (#642).
