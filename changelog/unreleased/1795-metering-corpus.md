---
type: feat
scope: corpus
---
The corpus catalogue carries the Metered Operation records: `charge-request` inputs, `charge-result` outcomes, `charge-refused` on `call` and `stub`, and the `metering` Operation setup key. The TS, Go and Zig runners replay them, and the Go API gains `Operation.Metering` and `Call.RequestCharge`. A TS charge `limit` no longer ends its Run without an outcome when a debugger pauses on Limit Faults (#1795).
