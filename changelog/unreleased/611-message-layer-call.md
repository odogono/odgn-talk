---
type: perf
---
Cut the Go Message Layer's work on every Capability call: Trace text for a crossing is built only when the Group has a Trace, and integer fields no longer go through a failed text decode. A call under `wasip1` in wasmtime takes about 19% less time (#611).
