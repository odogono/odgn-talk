---
type: feat
scope: spec
---

Specify named Shapes: `shape Invoice is {type: text, amount: GBP, ref: optional text}` declares a Constant holding Shape data, and `msg is an Invoice` tests a value against it as `conforms` does (ADR 0168).
