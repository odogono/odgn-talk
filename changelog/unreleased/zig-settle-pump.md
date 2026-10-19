---
type: perf
scope: repo
---

Carry the Go Zig adapter's queued `Call.Answer` and `Call.Fail` inside the next Pump, through the new `settlements-fields-v1` `settle-pump` frame, so a deferred call takes four binary guest exports instead of five with one JSON (#1320).
