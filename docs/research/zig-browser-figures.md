# The TS Core and the Zig reactor in a browser

Answers [#1121](https://github.com/odogono/odgn-talk/issues/1121)'s measurement: payload, startup, Pump throughput and memory for the TS Core and for the Zig `wasm32-wasi` reactor behind `@northtalk/ts/wasm`, both in Chromium, with the same Host code. [ADR 0097](../adr/0097-browser-hosts-may-run-the-zig-reactor-through-the-ts-embedding-api.md) records the decision these figures informed. They describe the commit below; the facade's current support and limitations live in the [TS guide](../../impl/ts/README.md#the-zig-reactor-in-a-browser).

## Outcome

**The reactor runs Scripts faster, but it costs about five times the payload and about 150 times the memory per Group.** Capability calls cost about the same on both Cores: each one crosses between JS and the guest as a JSON exchange, which takes about as long as the TS Core takes to make the call itself.

| Row | TS Core | Zig reactor | Zig ÷ TS |
| --- | --- | --- | --- |
| Payload, Brotli: the example Host's bundle | 147,122 B | 49,561 B + `talk.wasm` 720,067 B = 769,628 B | 5.2× |
| Payload, gzip -9 | 173,073 B | 57,178 B + 1,044,427 B = 1,101,605 B | 6.4× |
| Payload, raw | 595,928 B | 185,092 B + 3,092,745 B = 3,277,837 B | 5.5× |
| `createCore` | 0.01 ms | 6.7 to 7.5 ms (compiling `talk.wasm`) | – |
| First Group and Load, then its first Pump | 0.35 to 0.45 ms, 0.15 to 0.17 ms | 0.37 to 0.38 ms, 0.21 to 0.23 ms | about 1× |
| Pump throughput: a one-line Handler | 21,000 to 21,700 messages/s | 51,500 to 52,200 messages/s | 2.4× faster |
| Capability calls: one immediate call per message | 27,200 to 27,300 /s | 28,800 to 29,100 /s | 1.06× faster |
| A compute-bound Run: 100,000 passes, 1,385,877 Fuel | 141 ms | 33 ms | 4.3× faster |
| Memory per Group: JS heap | 15,200 to 15,800 B | 148,300 to 148,900 B | – |
| Memory per Group: linear memory | – | 2,162,688 B (33 pages) | – |
| Memory per Group, total | about 15 KB | about 2.3 MB | about 150× |
| The example's save | 7,569 B | 946 B | 0.13× |

Both pages ran [the core-switch example](../../impl/ts/examples/core-switch/) first. On each Core it loads a Script that waits on a suspending Operation, Pumps it, saves the Group, restores the save into a fresh Group, answers the pending call and finishes. The results, the ledger and all 16 Trace lines were the same on both Cores.

## Setup

| | |
| --- | --- |
| Commit | the #1121 branch, on `main` at `7b9e0aa7` |
| Machine | Apple M5, macOS 27.0.1 |
| Browser | Chromium 151.0.7922.34 (Playwright's headless shell), one fresh profile per page |
| Reactor | `zig build -Dtarget=wasm32-wasi` in `impl/zig`: Zig 0.17.0, the default safe build, stripped, as CI builds it |
| Bundles | `bun build --target browser --minify`, Bun 1.4.3; Brotli quality 11 and gzip -9 from `node:zlib` |
| Harness | [`impl/ts/tools/wasm-browser.ts`](../../impl/ts/tools/wasm-browser.ts), with its page in [`wasm-browser/`](../../impl/ts/tools/wasm-browser/) |

```sh
(cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi)
cd impl/ts && bun tools/wasm-browser.ts
```

Each row's range covers two runs. The figures are taken as follows:

- **Payload:** the [core-switch example's](../../impl/ts/examples/core-switch/) `ts.ts` and `wasm.ts`, each bundled alone. The whole packages bundle within 2 KB of these: 146,551 B Brotli for `@northtalk/ts` and 48,931 B for `@northtalk/ts/wasm`.
- **Startup:** `performance.now()` around `createCore`, then around a new Group and its Load, then around one Delivery and its Pump.
- **Throughput:** 2,000 Deliveries and then one Pump, seven rounds. Each figure is the median of the last five rounds.
- **Compute:** `spin 100000` adds each of 1 to 100,000 to a total, five rounds, median.
- **Memory:** 50 more Groups on a fresh Core, each with a Script and one Run. The JS heap is read through the DevTools protocol (`Runtime.getHeapUsage`, after `HeapProfiler.collectGarbage`), and linear memory from each Group's `memoryBytes()`.

## What it found

- **Synchronous instantiation works on the main thread.** `createCore` compiles the module once, asynchronously. Every later Group then instantiates it with `new WebAssembly.Instance`, which Chromium allows here, and its Load is as fast as on the TS Core.
- **Each Group costs a guest.** One instance per Group isolates a trap or memory exhaustion, but each one starts at 33 pages of linear memory, holding the reactor's 1 MiB stack, its 417 KB data section and its heap, plus about 150 KB of JS heap for the instance and its exports. The guest's `group-exchanges-v1` would let one instance hold many Groups (ADR 0097, Considered Options).
- **No memory cap is available.** #1121 hoped for a runtime-enforced linear-memory cap, as wasmtime's store limits give the Elixir Host. The Message Layer has no field for one, and JS can't cap a guest's own memory.
- **The facade's JS is mostly the TS Core's Value model.** Of its 183,584 B bundle, 47 KB is the generated Unicode tables that NFC normalization needs, and 22 KB the generated machine data, such as error messages and the default Limits. The facade itself is 15 KB.
- **The reactor has grown since [its first figures](zig-wasi-figures.md).** Those recorded 418,305 B Brotli at `7dc2628f`. The Core it measured didn't yet have save and restore, Capability Scopes or most Standard Capabilities. Its code section is now 2,667,383 B of the 3,092,745 B file.
- **The safe build links the rest of WASI.** Its panic handler needs 27 `wasi_snapshot_preview1` imports, including the filesystem calls. The facade gives the module a function for each import it names: it implements `fd_write`, `fd_read`, `random_get`, the clocks and an empty environment, and refuses the rest with `ENOSYS`. The Core reads no clock or file of its own; its Clock comes with each Pump.

## Fog

- **One machine, one browser.** Firefox and Safari compile and tier WebAssembly differently, and a phone's memory would make 2.3 MB per Group matter sooner.
- **The JS-heap figures are the heap's delta,** which counts what the collector keeps. Neither figure counts the compiled module, which the page holds once whatever the number of Groups.
- **Throughput includes the facade's JSON.** A Pump with many Reports pays for decoding them in JS, which a Host taking fewer Reports would pay less often.
