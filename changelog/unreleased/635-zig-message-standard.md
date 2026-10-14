---
type: feat
---
Carry `standard-capability` through the Zig Core's Message Layer on `wasm32-wasi` for `clock`, `calendar`, `locale`, `timer`, `console` and `user`: the Core answers `clock`, and the Host implements the others' Operations through `op` needs (#635).
