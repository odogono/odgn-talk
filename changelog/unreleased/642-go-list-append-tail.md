---
type: perf
---

Make appending to a Go Core List copy its storage once per 32 items instead of on every append, and shrink each Go Value slot from 32 to 24 bytes. Growing a List of `nothing` to the conformance-minimum Allocation Budget through the WASI reactor drops from 167s to about 60–80s in CI, and its peak linear memory from 6.3× to about 3× the budget (#642).
