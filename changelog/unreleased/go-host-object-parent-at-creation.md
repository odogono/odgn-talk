---
type: feat
scope: go
---

Let `Group.Object(kind, id, native, WithParent(p))` give a Host Object its parent when it is made, so a Host that makes Handles lazily inside a Pump can route a Script's send to the new object in the same Run (ADR 0152).
