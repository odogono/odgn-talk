---
type: perf
scope: ts
---
Reduce messaging and Script lifecycle overhead in the TS Core by skipping Trace formatting and Trace-only state counting when no Trace callback is installed, with unchanged Fuel (#1292).
