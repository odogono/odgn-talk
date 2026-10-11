# The Zig third Core is built though the Message Layer meets its thresholds

ADR 0071 gated a third Core on the Message Layer falling short for a named Host. [The measurements](../research/message-layer-measurements.md) for [#554](https://github.com/odogono/odgn-talk/issues/554) found that it doesn't: the Elixir Host passes on Wasmex and on the sidecar, and the C Host passes on wasmtime. The third Core in [#122](https://github.com/odogono/odgn-talk/issues/122) is built anyway, in Zig, with everything else in ADR 0071 unchanged. Its purpose is still embedding outside Go and TS, through `talk.h` natively and a `wasm32-wasi` build for Hosts with a WASM runtime. We chose this because passing the thresholds shows the Message Layer is usable, not that it is a good fit for embedding as Lua is. Each instance carries the Go runtime: 15.5 MiB against a 16 MiB threshold, with no regression check to protect that margin, and about 2 MiB of Brotli payload against an estimated 150 to 300 KB. A Host with no WASM runtime can't embed it at all except as a sidecar process, and every embedding call is a JSON round trip. We accept the cost that ADR 0071 gated on: every spec change and parity fix lands in three Cores, for good.

## Considered Options

- **Keeping ADR 0071's gate:** the measurements say the Message Layer is good enough for the two Hosts measured, so no third Core would be built. But the gate judges usability for those two Hosts on one machine, not the native `talk.h` reach that #122 exists for.
- **Waiting for a named Host to fall short:** a Host that needs a smaller payload, less memory or no WASM runtime would most likely never adopt the language rather than report a shortfall, so waiting may produce no evidence either way.
- **Rust instead of Zig:** unchanged from ADR 0071. Rust stays the fallback if Zig's pre-1.0 churn proves unworkable.

## Consequences

- **Supersedes ADR 0071's gate only.** The third Core is written from the Spec and the corpus, never translated from the Go or TS Core. Its targets are `talk.h` and `wasm32-wasi`. The browser stays on the TS Core, and saves stay per Core (ADR 0008). The Spec stays implementable without garbage collection.
- **The Message Layer stays,** and the Go `wasip1` build keeps serving Hosts with a WASM runtime until the Zig `wasm32-wasi` build conforms. Whether the Zig build then replaces it behind the Message Layer is decided by measuring both against [#532's thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), with the harnesses in `bench/message-layer-c` and `bench/message-layer/elixir`.
- **The payload and memory estimates are unmeasured.** The first Zig build that loads a Script records its Brotli payload and memory per instance against the Go reactor's 2.04 MiB and 15.5 MiB.
- Supersedes in part [ADR 0071](0071-a-third-core-serves-embedding-outside-go-and-ts-after-the-message-layer-is-measured.md).
