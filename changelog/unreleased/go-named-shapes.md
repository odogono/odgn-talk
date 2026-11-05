---
type: feat
scope: go
---

The embedded Zig Core loads named Shapes: `shape Invoice is {type: text, amount: GBP}` declares a Constant holding the Shape's data, and `msg is an Invoice` tests a value as `conforms(msg, Invoice)` does. A malformed declaration is the load diagnostic `bad shape`, and a Constant named like another Constant, a function or a Script Variable is now a `name clash` (ADR 0168).
