# TS Host code types against one embedding interface

`@northtalk/ts` and `@northtalk/ts/wasm` export the same `Core`, `Group` and `Script` interfaces, declared once in `impl/ts/src/embedding.ts`. The TS Core's classes (`TsGroup`, `TsScript`) and the Zig Host Adapter's (`WasmGroup`, `WasmScript`, `WasmCore`) each `implements` them. Without a shared type, the two copies drifted: six changes to `talk.ts` reached only the TS Core, and the parity tests cast with `as unknown as` to compile ([#1452](https://github.com/odogono/odgn-talk/issues/1452)). This makes ADR 0097's "Host code switches Cores by its import" a claim that `tsc` checks.

The interface is the intersection of the two Cores. Each concrete class adds its own extras: the TS Core's `save(options)` and debugger hooks, and the adapter's `memoryBytes`, `rebind` and Group `restore`. `createCore` stays outside the interface, sync on the TS Core and async on the adapter. Conveniences such as `invoke` and the `send failed` rejection are shared functions that each class delegates to, and the driver is written against the interface.

## Considered Options

- **A shared base class:** the two Groups share no state (the TS Core's scheduler against the adapter's guest Session), so a base class would hold only one-line delegations, and its private members would stop either Core from being typed structurally.
- **The union of both Cores' members:** Host code typed against it would compile and then fail on the other Core.
- **A public `Group` method for the driver to await pending Host operations:** this would put a TS-only method outside parity on the shared interface. Instead, both Cores fill one internal registry of pending operation Promises, keyed by Group.
- **Importing the types from `spec/embedding/talk.ts`:** this would make the spec part of the build. Instead, an apicheck test like Go's compares `embedding.ts` with `talk.ts`.

## Consequences

- Breaks TS Hosts that use `Group` as a value (`new Group`, `instanceof Group`); `Group` is now a type only. The abstract machine's `Script` export becomes `CompiledScript`, and the `ScriptHandle` alias goes.
- `newDrivenGroup` takes the Core: `newDrivenGroup(core, options)`. `@northtalk/ts/driver` then imports nothing from the TS Core, and works on either Core.
- Both Cores expose `core.versions`.
- A test fails when `index.ts` gains an export that `wasm/index.ts` lacks, unless the export is on its TS-only list.
