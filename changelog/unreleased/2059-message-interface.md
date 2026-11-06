---
type: feat
scope: tools
---

The editor reads a Script's message interface from its Clause Shapes: completion after `send` offers workspace Scripts' messages, hover on a `send` lists the Clauses that may answer it, and the `send-fits-no-clause` Lint warns when literal arguments fit none of them. A Clause Shape no longer makes a later clause `unreachable-clause` (#2059).
