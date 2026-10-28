---
type: fix
scope: ts
---
Keep the TS debugger from pausing inside a `set` through a property's value, so a Stop, cancel or Rewind made at a pause can't land between its Get and its Set, and defer a replay landing recorded inside one until the Set (#1642).
