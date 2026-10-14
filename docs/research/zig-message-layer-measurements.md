# The Zig and Go reactors measured behind the Message Layer

Answers the second half of [#635](https://github.com/odogono/odgn-talk/issues/635), for [ADR 0078](../adr/0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md)'s open consequence: whether the Zig `wasm32-wasi` build replaces the Go `wasip1` reactor behind the Message Layer. Both are measured against [#532's thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407) with the harnesses that measured the Go reactor first ([the Message Layer measurements](message-layer-measurements.md)), on the same machine and commit. This third run follows the Message Layer parity work on #635. The previous run, at `fd2f13be`, found the Zig build passing every row with a smaller message set; its results are beside these.

## Outcome

**Yes.** The Zig build passes every row on both Hosts and is faster, smaller and lighter than the Go reactor on every measured row: 2× to 25× on latency, 3.6× on memory per instance, and 3.3× to 4.5× on payload. The Go reactor misses one row this run: its C Host Capability call p50 is 58.1 µs against the 50 µs threshold, in all three runs.

The message gap the previous run left is closed. The Zig build now dispatches every message the Go reactor does: Capability and Object Kind definitions, Grants, Groups, loading, every queued Host Input, the Library messages, `reload` and `extend`, `inspect`, `grants` and `counters`, `save`, `restore` and `settle`, Function Values and `call`, `export-manifest`, and `standard-capability` (`store` included, merged in #910 after this run's commit; `sqlite` isn't offered through the layer). It also carries interim needs the Go reactor lacks: `effect` needs for Segment lifecycle hooks, made resumable in the Zig Core by #900, and the `resolve` need for `restore`.

Two differences remain, neither a reason to keep the Go build:

- **`request-charge`:** neither build carries it, because no Core implements Metered Operations yet. The Zig work is [#911](https://github.com/odogono/odgn-talk/issues/911).
- **A Pump's `abandoned`:** the Go reactor fills it; the Zig build returns it empty. Chapter 9 names the field in the `pump` reply but doesn't define its contents, so it needs a Spec decision before either build can be held to it.

**Recommendation:** replace the Go `wasip1` reactor with the Zig build behind the Message Layer. ADR 0078's conditions are met: every threshold row passes, the Zig Core is recorded as conforming ([#636](https://github.com/odogono/odgn-talk/issues/636)), and a Host now loses no message by switching. Settle `abandoned`'s definition first, or switch and define it afterwards, since no Host can rely on undefined contents; that and the switch-over itself are the maintainer's call.

## Setup

| | |
| --- | --- |
| Commit | `main` at `71d8bfda` |
| Machine | Apple M5, macOS 27.0.1; load average 1.5 to 2.9 during the runs |
| Zig build | `zig build -Dtarget=wasm32-wasi` in `impl/zig`, Zig 0.17.0, `f10aec0b…` |
| Go build | `mix talk.measure --build`, go1.27.2, `f4e19f1c…` |
| Elixir Host | [`bench/message-layer/elixir`](../../bench/message-layer/elixir/), Elixir 1.20.4, OTP 29, Wasmex 0.15.1 (wasmtime 47.0.2); the Zig build selected by `TALK_WASM`, on the `wasmex` and `c` transports (the sidecar is Go only); Docker 29.8.0 for the sidecar's containment |
| C Host | [`bench/message-layer-c`](../../bench/message-layer-c/), Wasmtime C API 49.0.2, Apple clang 21.0.0 |
| Method | #532's: 5,000 samples per latency run after 500 warm-up, three runs judged on the median run; 5,000 instantiations; 20 instances for memory; 20 repetitions per fault; 2,000 mutated sources |

Results: Elixir Host [Zig](../../bench/results/2026-10-14-71d8bfda-message-layer-elixir-darwin-arm64-apple-m5-zig.md) and [Go](../../bench/results/2026-10-14-71d8bfda-message-layer-elixir-darwin-arm64-apple-m5-go.md); C Host [Zig](../../bench/message-layer-c/results/2026-10-14-71d8bfda-darwin-arm64-apple-m5-zig.json) and [Go](../../bench/message-layer-c/results/2026-10-14-71d8bfda-darwin-arm64-apple-m5-go.json). The `fd2f13be` and `984c1717` runs are beside them.

## Results

### Elixir Host on Wasmex

| Row | Zig | Go | Threshold |
| --- | --- | --- | --- |
| Capability call p50 | **55.3 µs** (p99 85.5) | 113.7 µs (p99 256.7) | ≤ 500 µs |
| Pump p50 | **101.6 µs** (p99 179.4) | 210.6 µs (p99 401.3) | ≤ 250 µs |
| Instantiation p50 | **161 µs** | 1.19 ms | ≤ 50 ms |
| Memory per instance (median) | **2.1 MiB** | 7.5 MiB | ≤ 16 MiB |
| Payload, Brotli | **0.7 MiB** | 2.1 MiB | ≤ 3 MiB |
| Payload, raw | **2.8 MiB** | 12.6 MiB | ≤ 25 MiB |
| Containment, default limits under 128 MiB | pass | pass | Limit Fault, never out of memory |
| Containment, conformance minimums under 1 GiB | pass | pass | Limit Fault, never out of memory |
| Script faults | pass | pass | no trap and no lost instance |

### C Host on wasmtime

| Row | Zig | Go | Threshold |
| --- | --- | --- | --- |
| Capability call p50 | **7.5 µs** (p99 17.7) | 58.1 µs (p99 188.6) — over | ≤ 50 µs |
| Pump p50 | **8.7 µs** (p99 18.3) | 98.3 µs (p99 246.7) | ≤ 100 µs |
| Instantiation p50 | **36.0 µs** | 0.90 ms | ≤ 50 ms |
| Memory per instance (median) | **2.06 MiB** (2,162,688 bytes) | 7.5 MiB (7,864,320 bytes) | ≤ 16 MiB |
| Payload, Brotli / raw | **0.65 / 2.81 MiB** | 2.12 / 12.57 MiB | ≤ 3 / ≤ 25 MiB |
| Containment, conformance minimums under 1 GiB | pass | pass | through the Elixir Host's bridge |
| Script faults | pass | pass | through the Elixir Host's bridge |

The p50 of each C run: Zig's Capability call 7.50, 7.50 and 7.50 µs, Pump 8.75, 8.71 and 8.46 µs; Go's Capability call 58.42, 57.58 and 58.08 µs, Pump 98.33, 98.54 and 97.62 µs. Go's Capability call is over its threshold in every run, where at `fd2f13be` it was 42.3 µs; its Pump is just inside. The Zig figures moved less, from 8.0 and 7.0 µs. Load was lower this time than last, so it isn't the explanation; the change is not investigated here. No p99 is above 10× its p50, #532's line for investigating a tail; the widest is Go's C Capability call at 3.2×. Go's memory per instance fell from 15.75 MiB at `fd2f13be` to 7.5 MiB.

At the conformance minimum limits under the 1 GiB cap, the observed linear memory before each Limit Fault: Zig faults a growing List at 89.0 MiB, doubling text at 514.2 MiB and a growing Script Variable at 33.0 MiB, as at `fd2f13be`; Go at 222.0, 617.3 and 887.8 MiB on the C bridge and 222.0, 617.3 and 884.4 MiB on Wasmex. Uncapped, Go's growing Script Variable reached 1,561.8 MiB on the C bridge before its Limit Fault. The Script-fault suites lose no instance on either module or transport, and each instance answers `hello` and loads a fresh Script afterwards. The C Host's own 30 fault checks and 5 hostile frames likewise leave the same instance healthy after each.

## Why Zig is faster

Not profiled; the likely reasons are these. The Go reactor carries the Go runtime and its garbage collector in every instance, which is most of its 15.75 MiB and its 1 ms instantiation. Zig's instance is the Core's own data and a 1 MiB stack. On a call, Go's reactor crosses its `go:wasmexport` boundary into a goroutine scheduler; Zig's `talk_send` is a direct call. The C Host shows the difference undiluted, since the Elixir Host adds its own NIF and JSON costs to both.

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

Both Elixir runs write the same results file name for a day and commit, and the second merges into the first; rename the first before running the second. Both C runs write `bench/message-layer-c/out/measurements.json`, so copy it into `results/` after each.
