---
type: perf
scope: repo
---
Cut Go Zig adapter Host callback allocations by 11–33%: small integer arguments skip the rational conversion, and a Run's repeated clock reading is parsed once (#1103).
