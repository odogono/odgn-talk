---
type: feat
scope: tools
---
Add the beginner `suggest-match` hint for an `if` chain of three or more branches that each compare the same name with a literal, suggesting a `match` with a `when` per value. The LSP offers the rewrite as a quick fix (#1784).
