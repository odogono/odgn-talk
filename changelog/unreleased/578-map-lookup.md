---
type: feat
scope: spec
---
Add `lookup(m, path, default)` to the `map` Library. It reads a value through nested maps and lists, such as a `decodeJson` result, and gives `default` instead of raising `wrong kind` when a key or position along the way is missing or holds Nothing (#578).
