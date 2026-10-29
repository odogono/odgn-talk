---
type: feat
scope: tools
---
Add the beginner hints `suggest-arithmetic-command`, `suggest-is-in` and `suggest-otherwise`, which suggest `add n to x` for `put x + n into x`, `x is in [a, b, c]` for an `or` of comparisons, and `put x otherwise d into y` for an `if` that tests for Nothing. The LSP offers each rewrite as a quick fix (#1784).
