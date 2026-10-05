---
type: feat
scope: spec
---
Let a `send` compute its message name, as in `send (next) with order to me`. The name may be a Name or a Selector, and a name that can't be a message raises `bad message name` (ADR 0057).
