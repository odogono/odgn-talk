---
type: feat
scope: ts
---

Add a `closeTimeoutMs` driver option so `drive.close()` resolves after a bound, reporting Host `run` Promises still pending to `onCloseTimeout`, and document that a suspending Operation's `run` must settle once `call.signal` aborts (#1553).
