---
type: feat
scope: repo
---

The Zig Core loads named Shapes: `shape Invoice is {type: text, amount: GBP, ref: optional text}` declares a Constant holding the Shape's data, Libraries can export one, and `msg is an Invoice` tests a value as `conforms(msg, Invoice)` does. A malformed declaration is the load diagnostic `bad shape`, and a Constant named like another Constant, a function or a Script Variable is now a `name clash`, as the TS Core reports (ADR 0168).
