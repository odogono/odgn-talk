---
type: feat
scope: tools
---
Add the `store-race` Lint. It flags a `store` `set` of a key whose value came from a `get` of that key through the same Grant in one Handler, and points to `increment` or `swap`. It's a warning in `standard` and a hint in `beginner` (ADR 0050, #226).
