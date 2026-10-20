---
type: perf
scope: repo
---
Speed up Host Operation calls in the Zig Core: it builds a refused call's error context only on refusal, records issued calls without rehashing, and makes fewer allocations per crossing. Under the Go adapter, an immediate Operation crossing is about a quarter faster (#1103).
