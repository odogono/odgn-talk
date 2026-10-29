# One Host on both Cores

[`host.ts`](host.ts) is a Host written once against the embedding API. [`ts.ts`](ts.ts) runs it on the TS Core and [`wasm.ts`](wasm.ts) on the Zig reactor, through [`@northtalk/ts/wasm`](../../README.md#the-zig-reactor-in-a-browser). The two files differ only in their import ([ADR 0097](../../../../docs/adr/0097-browser-hosts-may-run-the-zig-reactor-through-the-ts-embedding-api.md)).

The Host defines a `stock` Capability. Its `price` Operation answers at once, and its `reserve` Operation is suspending. The Host loads a Script whose `order` Handler calls both, and Pumps it until it waits on `reserve`. It saves the Group, and restores the save into a fresh Group, which on the reactor is a fresh guest instance. It answers the pending call there with `settle` and Pumps the Run to its end.

Both Cores give the same result, ledger and Trace, and both write their saves in the one format either Core can restore.

```sh
(cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi)
bun test impl/ts/examples/core-switch
```

Without `talk.wasm`, the test runs the TS half only. [`tools/wasm-browser.ts`](../../tools/wasm-browser.ts) runs the example in headless Chromium on both Cores.
