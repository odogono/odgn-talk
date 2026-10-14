---
type: feat
---
Carry `standard-capability` for `store` through the Zig Core's Message Layer on `wasm32-wasi`: its Operations reach the Host as `op` needs, its lifecycle hooks as one Coordinator's `effect` needs, and its release hook as `release` needs (#635).
