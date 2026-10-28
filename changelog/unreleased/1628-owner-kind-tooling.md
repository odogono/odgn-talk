---
type: feat
scope: tools
---
When a Host Manifest names an Owner Kind, the LSP completes and hovers the properties of `me`, and the new `unknown-property` and `read-only-property` Lints flag a literal property its kind lacks and a `set` of a read-only one, for `me` and for well-known objects (#1628).
