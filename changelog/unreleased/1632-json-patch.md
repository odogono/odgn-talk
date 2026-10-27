---
type: feat
scope: spec
---
Add `applyPatch(doc, patch)` to the `json` Library, which applies an RFC 6902 JSON Patch to a value and raises the new `can't patch` error when an operation fails (#1632).
