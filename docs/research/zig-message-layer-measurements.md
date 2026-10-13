# The Zig and Go reactors measured behind the Message Layer

Answers the second half of [#635](https://github.com/odogono/odgn-talk/issues/635), for [ADR 0078](../adr/0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md)'s open consequence: whether the Zig `wasm32-wasi` build replaces the Go `wasip1` reactor behind the Message Layer. Both are measured against [#532's thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407) with the harnesses that measured the Go reactor first ([the Message Layer measurements](message-layer-measurements.md)), on the same machine and commit.

## Outcome

**Not yet.** The Zig build is faster, smaller and lighter on every measured row, by 3× to 30×, but it misses two of #532's rows that the Go reactor passes, on both Hosts:

- **Memory containment at the conformance minimum limits under 1 GiB** ([#804](https://github.com/odogono/odgn-talk/issues/804)): a Script doubling a text ends `out of memory` at about 941 MiB of linear memory before its Allocation Limit Fault. Go faults at about 478 MiB.
- **Script faults** ([#807](https://github.com/odogono/odgn-talk/issues/807)): Zig accepts `callDepth: 1000000`, which it can't honour, where Go refuses it as `invalid value`; the Runs end `out of memory`, and the instance can't load a Script afterwards, so the next case fails its health check. No instance traps or is lost.

**Recommendation:** replace the Go reactor with the Zig build once #804 and #807 are fixed and a remeasurement passes every row. Until then the Go reactor stays, as ADR 0078 says. Nothing else in these figures argues for keeping Go: its Pump p50 on Wasmex is within 12% of its threshold and its memory per instance within 2%, where Zig's margins are large.

## Setup

| | |
| --- | --- |
| Commit | `main` at `984c1717` |
| Machine | Apple M5, macOS 27.0.1; load average 3.5 to 5.2 during the runs, so latency is if anything high |
| Zig build | `zig build -Dtarget=wasm32-wasi` in `impl/zig`, Zig 0.17.0, `7df26cd1…` |
| Go build | `mix talk.measure --build`, Go 1.27.2, `60fe1911…` |
| Elixir Host | [`bench/message-layer/elixir`](../../bench/message-layer/elixir/), Wasmex 0.15.1 (wasmtime 47.0.2); the Zig build selected by `TALK_WASM`, on the `wasmex` and `c` transports (the sidecar is Go only) |
| C Host | [`bench/message-layer-c`](../../bench/message-layer-c/), Wasmtime C API 49.0.2, Apple clang 21.0.0 |
| Method | #532's: 5,000 samples per latency run after 500 warm-up, three runs judged on the median run; 5,000 instantiations; 20 instances for memory; 20 repetitions per fault; 2,000 mutated sources |

Results: Elixir Host [Zig](../../bench/results/2026-10-13-984c1717-message-layer-elixir-darwin-arm64-apple-m5-zig.md) and [Go](../../bench/results/2026-10-13-984c1717-message-layer-elixir-darwin-arm64-apple-m5-go.md); C Host [Zig](../../bench/message-layer-c/results/2026-10-13-984c1717-darwin-arm64-apple-m5-zig.json) and [Go](../../bench/message-layer-c/results/2026-10-13-984c1717-darwin-arm64-apple-m5-go.json).

## Results

### Elixir Host on Wasmex

| Row | Zig | Go | Threshold |
| --- | --- | --- | --- |
| Capability call p50 | **47.8 µs** (p99 122.7) | 130.7 µs (p99 408.2) | ≤ 500 µs |
| Pump p50 | **85.9 µs** (p99 283.7) | 221.1 µs (p99 668.5) | ≤ 250 µs |
| Instantiation p50 | **148 µs** | 1.46 ms | ≤ 50 ms |
| Memory per instance (median) | **1.9 MiB** | 15.8 MiB | ≤ 16 MiB |
| Payload, Brotli | **0.6 MiB** | 2.1 MiB | ≤ 3 MiB |
| Payload, raw | **2.4 MiB** | 12.3 MiB | ≤ 25 MiB |
| Containment, default limits under 128 MiB | pass | pass | Limit Fault, never out of memory |
| Containment, conformance minimums under 1 GiB | **miss** (#804) | pass | Limit Fault, never out of memory |
| Script faults | **miss** (#807) | pass | no trap and no lost instance |

### C Host on wasmtime

| Row | Zig | Go | Threshold |
| --- | --- | --- | --- |
| Capability call p50 | **8.4 µs** (p99 9.2) | 49.6 µs (p99 383.3) | ≤ 50 µs |
| Pump p50 | **7.4 µs** (p99 17.7) | 78.6 µs (p99 493.2) | ≤ 100 µs |
| Instantiation p50 | **32.8 µs** | 1.10 ms | ≤ 50 ms |
| Memory per instance (median) | **1.9 MiB** (2,031,616 bytes) | 15.75 MiB (16,515,072 bytes) | ≤ 16 MiB |
| Payload, Brotli / raw | **0.57 / 2.37 MiB** | 2.07 / 12.3 MiB | ≤ 3 / ≤ 25 MiB |
| Containment, conformance minimums under 1 GiB | **miss** (#804) | pass | through the Elixir Host's bridge |
| Script faults | **miss** (#807) | pass | through the Elixir Host's bridge |

The p50 of each C run: Zig's Capability call 8.29, 8.50 and 8.42 µs, Pump 7.42, 7.46 and 7.42 µs; Go's Capability call 49.63, 49.46 and 50.33 µs. One of Go's three runs is over its 50 µs threshold, so under this machine's load the Go reactor passes that row only on the median. No Zig p99 is above 2.5× its p50; Go's Capability call p99 is 7.7× its p50.

Every other Script-fault case passes on Zig with no instance lost, including the 2,000 mutated sources, the pathological sources and the malformed frames.

## Why Zig is faster

Not profiled; the likely reasons are these. The Go reactor carries the Go runtime and its garbage collector in every instance, which is most of its 15.75 MiB and its 1 ms instantiation. Zig's instance is the Core's own data and a 1 MiB stack. On a call, Go's reactor crosses its `go:wasmexport` boundary into a goroutine scheduler; Zig's `talk_send` is a direct call. The C Host shows the difference undiluted, since the Elixir Host adds its own NIF and JSON costs to both.

## What the misses need

- **#804:** find why the physical peak for doubling text is about twice the Allocation charge. The suspects are the transient copy at each doubling and `std.heap.wasm_allocator` never reusing a freed large text's pages.
- **#807:** refuse limits above what the Zig Core can honour at load, as `invalid value`; matching Go's cap at each limit's conformance minimum is the simplest. Then find what an `out of memory` Run leaves allocated, so the instance loads again afterwards.

## Reproducing

```sh
cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi && cd ../..
cd bench/message-layer/elixir
mix talk.measure --build                                  # Go
TALK_WASM=$PWD/../../../.cache/zig-wasi/bin/talk.wasm \
  mix talk.measure --transports wasmex,c                  # Zig
cd ../../..
bench/message-layer-c/run.sh                              # Go
bench/message-layer-c/run.sh "$PWD/.cache/zig-wasi/bin/talk.wasm"   # Zig
```

Both Elixir runs write the same results file name for a day and commit, and the second merges into the first; rename the first before running the second.
