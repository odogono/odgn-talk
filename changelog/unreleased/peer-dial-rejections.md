---
type: fix
scope: ts
---

A peer router whose `dial` rejects now fails `reach` with `bad address` and a waiting send with `send failed` (reason `unreachable`) at once, and drops a `post` quietly, instead of leaving an unhandled rejection and a Script waiting out its MaxWait (#2210).
