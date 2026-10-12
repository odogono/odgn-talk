---
type: fix
---
Reject Built-in properties anywhere on a Container's path in the Go and Zig Cores, reporting `not a container` at the target's first token, as chapter 2 requires. The Zig Core no longer writes such a target as a key of the property's name, and now accepts parenthesized Containers such as `put 1 into (x)` (#673).
