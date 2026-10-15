# Message Layer from an Elixir Host

An Elixir Host for the [Message Layer](../../../spec/09-embedding.md#the-message-layer). It measures what [#532](https://github.com/odogono/odgn-talk/issues/532) asks of each Host against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), for [#553](https://github.com/odogono/odgn-talk/issues/553). Nothing here is normative ([ADR 0054](../../../docs/adr/0054-benchmarks-live-outside-the-cores-and-only-advise-the-cost-model.md)).

It drives the Cores through two transports:

- **Wasmex:** the Zig [`wasm32-wasi` reactor](../../../impl/zig/README.md#building-and-testing), in Wasmex 0.15.1 (wasmtime 47), compiled with Cranelift `opt_level: :speed`.
- **Sidecar:** the native Zig [`messagelayer`](../../../impl/zig/README.md#native-message-layer-sidecar) on an Erlang Port, whose `{:packet, 4}` framing matches the sidecar's exactly.

It also runs its containment and fault suites against the [minimal C Host](../../message-layer-c/) on wasmtime, through that Host's `--serve` bridge on a Port, so the C Host faces the same cases (#554). That transport, `c, wasmtime`, runs when `bench/message-layer-c/out/host` exists; build it with `bench/message-layer-c/run.sh`. Its latency and memory are measured inside the C Host, since the Port would add to them.

```sh
cd bench/message-layer/elixir
mix deps.get
mix talk.measure --build                # builds .cache/ artifacts, measures, writes bench/results/
mix talk.measure --only latency         # remeasures one section into the day's results file
mix talk.measure --quick                # checks the harness; saves nothing, and its figures mean nothing
mix talk.measure --transports c         # measures some transports: wasmex, sidecar, c
mix talk.measure --render <file>.json   # rewrites a saved run's Markdown
mix test                                # round trips; includes C when out/host exists
```

`--build` builds the Zig reactor at `.cache/zig-wasi/bin/talk.wasm` and the
native and Linux Zig sidecars at `.cache/zig-native/bin/messagelayer` and
`.cache/zig-linux-{arm64,amd64}/bin/messagelayer`. Wasmex and the C bridge use this Zig module by
default. Set `TALK_WASM` to an explicit artifact path for another build; it
selects the module to measure without changing what `--build` builds.

The Go WASI entry point is retired ([ADR 0089](../../../docs/adr/0089-the-zig-build-serves-the-message-layer-reactor.md)). Go-reactor saves cannot be restored by Zig; start fresh Groups from source and Host-owned data, or retain the previous Go runtime/artifact until those Groups are drained or rebuilt. The native Go sidecar is also retired ([ADR 0090](../../../docs/adr/0090-the-native-message-layer-sidecar-uses-zig.md)); Go-sidecar saves require the same fresh-save cutover. The replacement supports Zig save/restore through the framed transport.

It needs Elixir 1.18 or later, Zig 0.17.0. The sidecar's memory containment runs the Linux build in a container, so it needs Docker. Without Docker, that row is reported as skipped. A full run takes about half an hour on an Apple M5. Latency figures are sensitive to other load, so the report records the load average at the start; run it on a quiet machine.

## What it measures

| Figure | How |
| --- | --- |
| Capability call | The time from receiving one `op` need to receiving the next, inside a Pump of 100 immediate calls. The handler answers at once with its argument, a small Map. |
| Pump | A `deliver` then a `pump` of an empty Handler, until its `run end`. |
| Instantiation | From a compiled module (Wasmex) or process spawn (sidecar) to the `hello` reply. Compile time is reported separately. |
| Memory per instance | Linear memory (Wasmex) or RSS (sidecar), after `hello`, a Group, a small Script and one Pump. |
| Memory containment | Scripts that grow a List, double a text, or grow a Script Variable, until they fault. They run under the default limits with a 128 MiB cap, then under the conformance minimums with a 1 GiB cap. The cap is `Wasmex.StoreLimits` for Wasmex, the Store limiter for the C Host, and `docker run --memory` for the sidecar. |
| Script faults | Fuel, allocation, Persistent State and call depth Limit Faults, a full mailbox, `throw`, run-time errors and Operation failures. Then pathological sources, 2,000 seeded mutations of the corpus's Scripts, and malformed frames. A lost instance is recorded against its input and replaced, and each case ends with a health check. |

Latency and instantiation figures take 5,000 samples after warm-up, three times, and are judged on the median run. They gate on p50 only, and a p99 above 10× its p50 is flagged instead.

## Layout

| Path | Contents |
| --- | --- |
| [`lib/talk_host/transport/`](lib/talk_host/transport/) | The Wasmex and Port transports. |
| [`lib/talk_host/session.ex`](lib/talk_host/session.ex) | The Host's side of the protocol: `ref`s, and answering `op` and `prop` needs. |
| [`lib/talk_host/measure.ex`](lib/talk_host/measure.ex) | Latency, instantiation and memory. |
| [`lib/talk_host/containment.ex`](lib/talk_host/containment.ex), [`faults.ex`](lib/talk_host/faults.ex), [`hostile.ex`](lib/talk_host/hostile.ex) | Memory containment, the fault cases, and the hostile inputs. |
| [`lib/talk_host/report.ex`](lib/talk_host/report.ex) | The verdict against #532's thresholds, and the Markdown report. |
