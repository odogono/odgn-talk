---
type: feat
scope: tools
---
Add the `if-then-return-bool` hint, which suggests `return c` for an `if` on a comparison, `and`, `or` or `not` whose branches only return `true` and `false`, with a quick fix (#1784).
