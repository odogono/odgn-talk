---
type: feat
scope: spec
---
Specify Clause Shapes (ADR 0171): `on handle inv is an Invoice where …` lets a Handler Clause require that an argument fits a kind or a named Shape. A message that doesn't fit skips the clause, as a Guard would, at the same Fuel; `is not a` in a head is the new load error `negated shape`.
