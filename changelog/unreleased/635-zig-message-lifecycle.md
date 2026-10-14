---
type: feat
---
Carry Segment lifecycle and Grant release through the Zig Core's Message Layer on `wasm32-wasi`: `define-capability` takes scopes, Segment-bound Operations, `segmentLifecycle` and `release`, `grant` takes a shared `coordinator`, and a Pump sends `effect`, automatic `op` and `release` needs (#635).
