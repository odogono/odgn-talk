---
type: feat
scope: repo
breaking: true
---
Give Instants, Civil Dates and exact durations microsecond resolution (ADR 0091). The `nanosecond` Built-in becomes `microsecond`, the `ns` parameter of `makeDateTime` and `atTime` becomes `us`, `${fraction:n}` takes n from 1 to 6, date text takes a fraction of one to six digits, Go `time.Time` values truncate to the microsecond, and Host builders take microseconds. Saves written under nanosecond resolution are refused (#1001).
