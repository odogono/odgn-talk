---
type: feat
scope: ts
---
Add `script.handlers` to Scripts loaded through `createGroup`, and `handlersOf(script)` for any Script, to call Handlers with plain JS arguments and answers over either Core. `group.load<T>()` optionally types those calls.
