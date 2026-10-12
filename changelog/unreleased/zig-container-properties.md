---
type: fix
---
Reject Built-in properties at every Container path level in the Zig and Go Cores, including `set`, with `not a container` at the target's first token. Preserve parenthesized Containers, ordinary keys and auxiliary property reads (#673, #681).
