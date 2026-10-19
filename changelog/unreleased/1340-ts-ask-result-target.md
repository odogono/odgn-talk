---
type: feat
scope: ts
---
The TS Core parses and lowers a Result Target on `ask`: `ask world to lies item into location` puts the answer into `location` as `put it into location` would, and `it` is still set. A Join Member with a Result Target is `not in a join` at its `into` (#1340).
