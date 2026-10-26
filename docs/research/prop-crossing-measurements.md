# Property crossings measured in-process and behind the Message Layer

Answers [#1572](https://github.com/odogono/odgn-talk/issues/1572). The research note on Host-resolved element queries ([#1571](https://github.com/odogono/odgn-talk/pull/1571)) priced a Core-resolved `every element … whose` by assuming a `prop` crossing costs what a Capability call does, because no measurement timed one. This note times them: a Host Object property get, an Object Collection `at`, and a whole Core-resolved query over 10, 216 and 1,000 members. That query is [ADR 0100](../adr/0100-object-element-references-use-a-fixed-spelling-and-a-host-collection.md)'s deferred form, written out as a loop over the declared getters.

## Outcome

A `prop` crossing costs no more than a Capability call on any measured Host. It costs less on all but the sidecar, where they're about equal. The note's estimate was pessimistic for the C Host and about right for Wasmex:

| Host | Capability call p50 | Property get p50 | Collection `at` p50 | 216-member query p50 | The note's 216 estimate |
| --- | --- | --- | --- | --- | --- |
| TS Core, in-process | 1.17 µs | 0.92 µs | not measured | not measured | – |
| C Host, wasmtime | 5.67 µs | 2.50 µs | 2.96 µs | 1.27 ms | about 3.2 ms |
| Elixir, Zig sidecar | 12.3 µs | 10.1 µs | 9.8 µs | 4.42 ms | – |
| Elixir, Wasmex | 55.4 µs | 42.0 µs | 42.2 µs | 21.8 ms | about 24 ms |

The query cost grows linearly with membership: one `count`, then an `at` and a `get` per member, so 2n + 1 crossings. A Host-resolved query would replace those with about one crossing plus the Host's own scan. That saves roughly 1.3 ms on the C Host, 4.4 ms on the sidecar and 22 ms on Wasmex for 216 members, and about 8 ms, 22 ms and 103 ms for 1,000.

**Verdict:** Host-side resolution isn't worth an ADR yet. Specify the Core-resolved meaning first. Write the Host-side ADR only when a Wasmex or sidecar Host has a query over hundreds of members on a latency-sensitive path, such as once per frame. In-process Hosts, including Folio on the TS Core, would save well under a millisecond at Folio's sizes.

## Setup

| | |
| --- | --- |
| Commit | `main` at `e8ada281`, with this branch's harness changes uncommitted at the time; the results files name the base commit |
| Machine | Apple M5, macOS 27.0.1; load average 1.6 to 2.5 during the runs |
| Reactor | `zig build -Dtarget=wasm32-wasi`, Zig 0.17.0, and the native Zig sidecar from `zig build sidecar` |
| C Host | [`bench/message-layer-c`](../../bench/message-layer-c/), Wasmtime C API; [results](../../bench/message-layer-c/results/2026-10-26-e8ada281-darwin-arm64-apple-m5-zig.json) |
| Elixir Host | [`bench/message-layer/elixir`](../../bench/message-layer/elixir/), Elixir 1.20.4, OTP 29, Wasmex 0.15.1; [results](../../bench/results/2026-10-26-e8ada281-message-layer-elixir-darwin-arm64-apple-m5.md) |
| TS Core | `bun run bench --filter host/ --only ts --count 5`, the Benchmark Suite's `host/properties` and `host/immediate` at n = 500, not saved |
| Method | #532's for the per-need figures: 5,000 samples after 500 warm-up, three runs judged on the median run. Queries: 200 per run after three warm-up, three runs |

Both harnesses define the figures the same way ([C Host](../../bench/message-layer-c/README.md#property-crossings)). The Host opts into `object-elements-v1` and answers every `prop` need at once: a `box` with one number property, and a `page` whose collection reports `n` `rect` members with the same property. All Getters cost 1 Fuel.

- **Property get** and **collection `at`:** the time from the Host receiving one `prop` need to receiving the next, inside a Pump of 100 reads, as the Capability call figure times `op` needs.
- **Query:** a whole `deliver` and `pump` of a Handler that reads `the value of element i of p` for `i` from 1 to `the number of elements of p`, until its `run end`.
- **TS Core:** each figure is the suite's Run median for 500 iterations divided by 500. It includes one loop iteration and one `add` per crossing, and it's a direct call into the Host, not a need.

## Results

### C Host on wasmtime

| Figure | p50 | p99 |
| --- | --- | --- |
| Capability call | 5.67 µs | 5.96 µs |
| Property get | 2.50 µs | 2.62 µs |
| Collection `at` | 2.96 µs | – |
| Query, 10 members (21 needs) | 61.5 µs | 67.4 µs |
| Query, 216 members (433 needs) | 1.27 ms | 1.30 ms |
| Query, 1,000 members (2,001 needs) | 7.83 ms | 8.13 ms |

### Elixir Host

| Transport | Figure | p50 | p99 |
| --- | --- | --- | --- |
| Zig sidecar | Property get | 10.1 µs | 15.7 µs |
| Zig sidecar | Collection `at` | 9.8 µs | 15.1 µs |
| Zig sidecar | Query, 10 members | 236 µs | 258 µs |
| Zig sidecar | Query, 216 members | 4.42 ms | 4.65 ms |
| Zig sidecar | Query, 1,000 members | 22.0 ms | 28.5 ms |
| Wasmex | Property get | 42.0 µs | 120.5 µs |
| Wasmex | Collection `at` | 42.2 µs | 108.5 µs |
| Wasmex | Query, 10 members | 1.03 ms | 1.46 ms |
| Wasmex | Query, 216 members | 21.8 ms | 36.1 ms |
| Wasmex | Query, 1,000 members | 103 ms | 114 ms |

The Capability call figures in the Outcome table come from the same day's Elixir latency section: 12.3 µs on the sidecar and 55.4 µs on Wasmex.

## Caveats

- **Running order matters for Elixir.** In the first full run, the crossings section ran straight after the latency section's 5,000 instantiations per transport. There the sidecar's property get measured 53.7 µs and its 216-member query 30.4 ms. Run alone, they were 9.4 to 10.1 µs and 4.3 to 4.5 ms over three separate runs. The recorded figures are from a run of the crossings section alone. Run it on its own.
- **No native Zig figure.** The Benchmark Suite's native Zig Host doesn't install property bindings yet (a runner limitation recorded in `benchmarks.json`), so in-process Zig isn't measured. The C Host's figure includes the reactor's JSON framing; a native embedding would be cheaper.
- **The TS figure isn't comparable row for row.** It is a Script loop with an `add`, timed by the suite, not an interval between needs. It's recorded only to show in-process crossings are around a microsecond. An earlier M5 run on 2026-10-18 measured 2.7 µs per property read, so the suite's variance here is large.
- **Answers are immediate.** Every Host answers from memory without work. A real Host's lookup adds to each crossing, and a Host-resolved query would pay for its own scan instead.
- **Interim results now name their Group.** Both harnesses' `op-result` and `prop-result` frames lacked the `group` field the reactor has required since `group-exchanges-v1`, and the C Host failed on `main` with `the result must address the exchange's Group` until this change; the Elixir Session wasn't checked on `main`. Both now copy the exchange's Group into the result.
