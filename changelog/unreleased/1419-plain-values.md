---
type: feat
scope: ts
---

Add `toValue` and `fromValue`, which convert between Script Values and plain JS data. `toValue` refuses a JS `number` unless the Host passes `{ numbers: 'decimal' }` (ADR 0119, #1419).
