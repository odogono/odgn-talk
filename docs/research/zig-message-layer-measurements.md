# The Zig and Go reactors measured behind the Message Layer

Answers the second half of [#635](https://github.com/odogono/odgn-talk/issues/635), for [ADR 0078](../adr/0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md)'s open consequence: whether the Zig `wasm32-wasi` build replaces the Go `wasip1` reactor behind the Message Layer. Both are measured against [#532's thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407) with the harnesses that measured the Go reactor first ([the Message Layer measurements](message-layer-measurements.md)), on the same machine and commit. This is the remeasurement the first run of 2026-10-13 called for, after its two misses were fixed: [#804](https://github.com/odogono/odgn-talk/issues/804) by [#810](https://github.com/odogono/odgn-talk/pull/810) and [#807](https://github.com/odogono/odgn-talk/issues/807) by [#813](https://github.com/odogono/odgn-talk/pull/813).

## Outcome

**Yes, on #532's thresholds.** The Zig build now passes every row on both Hosts, and is faster, smaller and lighter than the Go reactor on every measured row, by 1.7× to 30×. Both former misses are gone:

- **Memory containment at the conformance minimum limits under 1 GiB** ([#804](https://github.com/odogono/odgn-talk/issues/804)): doubling text now ends in its Allocation Limit Fault at 514.2 MiB of linear memory, below the Go reactor's 624.8 MiB, where it previously ran out of memory at about 941 MiB.
- **Script faults** ([#807](https://github.com/odogono/odgn-talk/issues/807)): `callDepth: 1000000` is now refused at load as `invalid value`, and no instance is lost to any fault case, on either transport.

**Recommendation:** replace the Go `wasip1` reactor with the Zig build behind the Message Layer. The condition the first measurement set — #804 and #807 fixed and a remeasurement passing every row — is met, and the Zig Core has since been recorded as conforming ([#636](https://github.com/odogono/odgn-talk/issues/636)), which is ADR 0078's other condition for the Go build to stand down. One bar remains, and it is not in these figures: the Zig build's Message Layer still carries a smaller message set than the Go reactor's (`restore`, `resolve`, `settle`, `standard-capability`, `inspect`, `counters`, `effect`/`release` needs, load `owner`/`objects` and `$function` values are protocol errors, where Go also carries messages such as `reload`, `broadcast` and the library messages). A Host using only the messages both carry can switch now; a Host using the rest cannot, so the switch-over point is the maintainer's call against that remaining work on #635, not against performance.

## Setup

| | |
| --- | --- |
| Commit | `main` at `fd2f13be` |
| Machine | Apple M5, macOS 27.0.1; load average 2.9 to 4.7 during the runs, so latency is if anything high |
| Zig build | `zig build -Dtarget=wasm32-wasi` in `impl/zig`, Zig 0.17.0, `bf98df48…` |
| Go build | `mix talk.measure --build`, Go 1.27.2, `9851b397…` |
| Elixir Host | [`bench/message-layer/elixir`](../../bench/message-layer/elixir/), Wasmex 0.15.1 (wasmtime 47.0.2); the Zig build selected by `TALK_WASM`, on the `wasmex` and `c` transports (the sidecar is Go only) |
| C Host | [`bench/message-layer-c`](../../bench/message-layer-c/), Wasmtime C API 49.0.2, Apple clang 21.0.0 |
| Method | #532's: 5,000 samples per latency run after 500 warm-up, three runs judged on the median run; 5,000 instantiations; 20 instances for memory; 20 repetitions per fault; 2,000 mutated sources |

Results: Elixir Host [Zig](../../bench/results/2026-10-14-fd2f13be-message-layer-elixir-darwin-arm64-apple-m5-zig.md) and [Go](../../bench/results/2026-10-14-fd2f13be-message-layer-elixir-darwin-arm64-apple-m5-go.md); C Host [Zig](../../bench/message-layer-c/results/2026-10-14-fd2f13be-darwin-arm64-apple-m5-zig.json) and [Go](../../bench/message-layer-c/results/2026-10-14-fd2f13be-darwin-arm64-apple-m5-go.json). The first run's results, at `984c1717`, are beside them.

## Results

### Elixir Host on Wasmex

| Row | Zig | Go | Threshold |
| --- | --- | --- | --- |
| Capability call p50 | **57.4 µs** (p99 71.6) | 99.1 µs (p99 344.4) | ≤ 500 µs |
| Pump p50 | **96.8 µs** (p99 153.3) | 176.5 µs (p99 545.9) | ≤ 250 µs |
| Instantiation p50 | **161 µs** | 1.26 ms | ≤ 50 ms |
| Memory per instance (median) | **2.0 MiB** | 15.8 MiB | ≤ 16 MiB |
| Payload, Brotli | **0.6 MiB** | 2.1 MiB | ≤ 3 MiB |
| Payload, raw | **2.7 MiB** | 12.5 MiB | ≤ 25 MiB |
| Containment, default limits under 128 MiB | pass | pass | Limit Fault, never out of memory |
| Containment, conformance minimums under 1 GiB | pass | pass | Limit Fault, never out of memory |
| Script faults | pass | pass | no trap and no lost instance |

### C Host on wasmtime

| Row | Zig | Go | Threshold |
| --- | --- | --- | --- |
| Capability call p50 | **8.0 µs** (p99 9.9) | 42.3 µs (p99 226.7) | ≤ 50 µs |
| Pump p50 | **7.0 µs** (p99 8.7) | 69.3 µs (p99 365.6) | ≤ 100 µs |
| Instantiation p50 | **31.0 µs** | 0.93 ms | ≤ 50 ms |
| Memory per instance (median) | **2.0 MiB** (2,097,152 bytes) | 15.75 MiB (16,515,072 bytes) | ≤ 16 MiB |
| Payload, Brotli / raw | **0.62 / 2.69 MiB** | 2.10 / 12.46 MiB | ≤ 3 / ≤ 25 MiB |
| Containment, conformance minimums under 1 GiB | pass | pass | through the Elixir Host's bridge |
| Script faults | pass | pass | through the Elixir Host's bridge |

The p50 of each C run: Zig's Capability call 8.04, 8.00 and 8.00 µs, Pump 6.96, 7.00 and 6.96 µs; Go's Capability call 42.58, 42.29 and 42.33 µs, Pump 69.25, 69.21 and 69.62 µs. Every Go run is inside its threshold this time, where one of three was over in the first run. No p99 on either Host is above 10× its p50, #532's line for investigating a tail; the widest is Go's C Capability call at 5.4×.

At the conformance minimum limits under the 1 GiB cap, the observed linear memory before each Limit Fault: Zig faults a growing List at 89.0 MiB, doubling text at 514.2 MiB and a growing Script Variable at 33.0 MiB; Go at 261.5, 624.8 and 685.1 MiB. The Script-fault suites — Limit Faults of each kind, deep recursion at the default, conformance-minimum and 1,000,000 depths, a full mailbox, `throw`, run-time and Operation errors, pathological sources, the 2,000 mutated sources and malformed frames — lose no instance on either module or transport, and each instance answers `hello` and loads a fresh Script afterwards. The C Host's own 30 fault checks and 5 hostile frames likewise leave the same instance healthy after each.

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

Both Elixir runs write the same results file name for a day and commit, and the second merges into the first; rename the first before running the second.
