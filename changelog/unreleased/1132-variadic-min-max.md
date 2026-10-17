---
type: feat
scope: spec
---
`min` and `max` take their values as arguments, so `max(6, 3, 9)` is `9`, and a single list argument still means its items (ADR 0099, #1132). They are the first variadic Built-ins, written `max(x, …)` in the catalogue.
