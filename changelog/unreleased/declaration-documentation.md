---
type: feat
breaking: true
---
Both Session Hosts attach `--|` Declaration Documentation to top-level functions, Handler Clauses, Constants and Script Variables. It is retained through redefinition, export, reload and save/restore, and a stale Function Value keeps its code's documentation. At the prompt, a leading doc block waits for its declaration, and a block before a statement, expression or Import is refused with `! bad arguments`. Saves move to new private formats (Go `go/4`, TS `4`) to keep stale documentation; older snapshots are no longer readable. Part of #370.
