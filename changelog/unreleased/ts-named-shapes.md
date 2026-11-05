---
type: feat
scope: ts
---

The TS Core loads named Shapes: `shape Invoice is {type: text, amount: GBP, ref: optional text}` declares a Constant holding the Shape's data, Libraries can export one, and `msg is an Invoice` tests a value as `conforms(msg, Invoice)` does. A malformed declaration is the load diagnostic `bad shape` (ADR 0168).
