---
type: feat
scope: ts
---

Let `group.object(kind, id, native, { parent })` give a Host Object its parent when it is made, so a Host that makes Handles lazily inside a Pump can route a Script's send to the new object in the same Run (ADR 0152). The `@northtalk/ts/wasm` Group refuses the option until the Zig reactor supports it.
