---
type: feat
scope: ts
---

The TS Core runs Clause Shapes: `on handle inv is an Invoice` skips the clause unless the argument fits the kind or named Shape, and `is not a` in a head is the load error `negated shape` (ADR 0171, #2136).
