---
type: fix
---
A `send` to a Script the Group doesn't hold now raises `object gone` at the `send`, as chapter 5 says, instead of at the `load-object` that names the Script. The Go and TS Cores now agree with the Zig Core and with a computed `send`, and the error's position is the statement's (#733).
