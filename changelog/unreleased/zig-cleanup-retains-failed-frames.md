---
type: fix
scope: repo
---

The Zig Core keeps an uncaught error's failed frames while its `finally` blocks run, as the TS Core does, so they count toward Persistent State and call depth, and a save holds them.
