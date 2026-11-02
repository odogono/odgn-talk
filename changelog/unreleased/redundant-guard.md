---
type: feat
scope: tools
---
Add the hint `redundant-guard`, which flags a `where` test that its pattern already guarantees, such as `when [a, b] where v is a list`, with an LSP quick fix that removes it (#1784).
