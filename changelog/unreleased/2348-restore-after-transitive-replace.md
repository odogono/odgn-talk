---
type: fix
scope: ts
---
A Session `:restore` straight after `:save` is now full when a `:library replace` recompiled the Libraries that import the replaced one, instead of refusing as `save mismatch` (#2348).
