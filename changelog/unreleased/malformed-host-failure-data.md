---
type: fix
scope: ts
---
Raise `host error` and emit a `call failed` report when an Operation or Object property failure's Data is neither a map nor Nothing, matching the Go Core (#487).
