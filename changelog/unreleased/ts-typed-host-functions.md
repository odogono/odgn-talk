---
type: feat
scope: ts
breaking: true
---

Type Capability Host functions from their Shapes (ADR 0120): `do`, `run`, `start` and `fire` take arguments as JS values (`shape.text` as a `string`, `shape.number` as a `Decimal`, and so on), and may return the result's JS form. A Capability with a binding is now defined with `defineCapability<Binding>()(name, ops)`.
