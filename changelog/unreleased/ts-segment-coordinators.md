---
type: feat
scope: ts
---
Let Segment-bound Grants share a Segment Coordinator in the TS Core: `defineCapability` accepts a `coordinator` mapping, Grants mapped to one coordinator enroll in one participant with a single `begin` and one `commit` or `rollback` over them all, and `case.toml` Grants take a `coordinator` name (ADR 0069).
