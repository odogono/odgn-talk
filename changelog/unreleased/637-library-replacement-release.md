---
type: fix
scope: ts
---
Release every affected Script's Grants with `stop` when a Library replacement's cleanup leaves effect state unknown, matching Go. Complete all affected Scripts' abandonment and rollback before publishing reload releases or Stop reports (#637).
