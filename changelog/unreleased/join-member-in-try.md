---
type: fix
---
The Go Core reports `not in a join` for a waiting `ask`, `send` or `tell` block line inside a `try` in a Join's body, as the TS Core does. A `try` around the whole Join still loads.
