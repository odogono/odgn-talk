---
type: feat
scope: ts
---
Add `createGroup({ name, core?, ...driverOptions })` for a driven Group with `close(reason?)` and `await using` disposal. The root export defaults to the process-wide TS Core; `/wasm` requires an explicit Core.
