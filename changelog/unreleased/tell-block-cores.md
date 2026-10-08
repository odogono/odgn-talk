---
type: feat
---
Implement `tell g` blocks in both Cores: each line calls an Operation of the Grant `g` as its declared mode allows, with errors and Suspension Points at the Operation name. The formatter indents block lines, the LSP completes and describes their Operations, and `DefineCapability` refuses `end` as an Operation name (#337, ADR 0063).
