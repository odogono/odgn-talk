---
type: feat
scope: ts
breaking: true
---
`@northtalk/ts` and `@northtalk/ts/wasm` export one `Core`, `Group` and `Script` interface, which the TS Core and the Zig Host Adapter both implement, so Host code typed against them switches Cores by its import (ADR 0121). The TS Core's classes are now `TsGroup` and `TsScript`: `Group` is a type only, and the `ScriptHandle` alias is gone. The Abstract Machine's `Script` export is now `CompiledScript`. `newDrivenGroup` takes the Core first, as `newDrivenGroup(core, options)`, and the driver works on either Core, with `close()` waiting for the adapter's Host Promises too. The adapter gains `Script.invoke`, `core.versions` on the TS Core matches it, and it now exports `toValue`, `fromValue`, `talk`, `nowMicros` and `SendFailedReason`.
