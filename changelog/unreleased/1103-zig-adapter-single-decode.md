---
type: perf
scope: repo
---
Speed up the Go Zig adapter by reading each guest reply once: the envelope is read in place and each Value Encoding is decoded straight from its bytes, cutting Go allocations per request by about 70% (#1103).
