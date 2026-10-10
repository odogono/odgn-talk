---
type: perf
---
Share unchanged Map entries and List chunks across writes in both Cores, making key writes, point edits and branched List growth logarithmic in collection size. Preserve insertion order, retained values, Fuel and logical allocation (#598).
