---
type: fix
scope: go
---

`Group.Libraries()` returns the Group's Libraries, including the dependants a transitive `:library replace` recompiled, so a restore after that replace is full rather than refused; the embedded reactor is now v0.33.1, which also writes no `mode` on a refused restore's Trace record.
