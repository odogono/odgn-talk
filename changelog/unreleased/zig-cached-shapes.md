---
type: perf
scope: repo
---
Keep the Zig Core's decoded Shapes per Group, rather than decoding a Shape's data on every `conforms`, `check`, `explain` or Clause Shape test, with Fuel and the Trace unchanged: `core/shapes` runs about 60% faster (#2196).
