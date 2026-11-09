---
type: fix
scope: tools
---

Folio checks Mini-Notation written in raw `"""…"""` or hole-free backtick text when a Script loads and underlines the bad step inside the fence, and a pattern that fails at run time names its bad step instead of reporting only that `sound` failed (#2173).
