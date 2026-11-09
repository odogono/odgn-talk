---
type: perf
scope: ts
---
Decode a Shape's data once and reuse it, rather than on every `conforms`, `check`, `explain` or Clause Shape test, with Fuel and the Trace unchanged: `core/shapes` runs about 24% faster and `messaging/shape-sends` about 13% faster (#2196).
