---
type: fix
scope: ts
---
Reject Built-in properties anywhere on a Container's path during parsing, reporting `not a container` at the target's first token. Preserve quoted/computed keys and property reads in selector and value expressions (#672).
