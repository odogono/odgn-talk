---
type: fix
---
Let the Zig Core's lists and maps nest without its former 128-level cap, which refused deeper values with a Host error. Values deeper than that now run, compare, display, encode, decode, save and restore as on the Go and TS Cores, bounded only by the Allocation Budget, Persistent State and memory, each with its specified fault (#871).
