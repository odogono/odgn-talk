---
type: feat
scope: ts
---

The TS Core gives every load diagnostic an end position, `endLine` and `endCol`, so a Host can mark the whole token it is reported at, and the Trace writes it as `end=` on each `diag` record.
