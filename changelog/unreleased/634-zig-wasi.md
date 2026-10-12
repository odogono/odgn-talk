---
type: feat
---
Run the Zig Core's `wasm32-wasi` build in wasmtime and measure it: a stripped build with a 1 MiB stack, `talk_alloc` and `talk_free` for Hosts in another address space, and a CI check of its memory per instance and payload against #532's thresholds (#634).
