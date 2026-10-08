---
type: fix
scope: ts
---
Recheck queued parent changes at drain, refusing cycles and disposed children through Pump reports without changing the parent (#457).
