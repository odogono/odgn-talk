---
type: fix
scope: ts
---
Shape checks (`conforms`, `explain` and Host checks) no longer throw a TypeError when a value holds the same part both directly and inside another of its parts (#2209).
