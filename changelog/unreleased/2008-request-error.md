---
type: fix
scope: ts
---

A Request whose Run ends `errored` now rejects with `send failed` carrying the Run's `error` map beside its `reason`, as the Zig Core does, so a Remote Send to a TS Runner's Script that throws brings back the thrown error (#2008).
