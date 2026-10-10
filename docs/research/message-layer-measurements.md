# The Message Layer measured for an Elixir Host and a C Host

Answers [#554](https://github.com/odogono/odgn-talk/issues/554), part of [#532](https://github.com/odogono/odgn-talk/issues/532). It judges the Message Layer measurements from [#552](https://github.com/odogono/odgn-talk/issues/552) and [#553](https://github.com/odogono/odgn-talk/issues/553) against [the thresholds set in #532](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), and records what they mean for a third Core ([#122](https://github.com/odogono/odgn-talk/issues/122), [ADR 0071](../adr/0071-a-third-core-serves-embedding-outside-go-and-ts-after-the-message-layer-is-measured.md)).

## Outcome

**The Message Layer is good enough for both Hosts, and no third Core is built.** #122 does not proceed.

- **The Elixir Host** meets every row on Wasmex and on the sidecar. It needed only one of the two.
- **The C Host** meets every row on wasmtime.
- **The sidecar doesn't decide the outcome,** because Wasmex passes on its own. So ADR 0071 needs no amendment for counting the sidecar as the Message Layer, and there is no Wasmex shortfall to report.

The thresholds were met only after six Go Core fixes and two harness fixes, all found by this measurement. They are listed under [what it took](#what-it-took). The narrowest margins are under [margins](#margins).

## Setup

| | |
| --- | --- |
| Commit | `2605c656`, `main` at `fd6ed1bf` plus the harness changes in this PR |
| Machine | Apple M5, macOS 27.0.1, one machine for every figure |
| Go | 1.27.2; the stripped `wasip1` reactor `ac9e2a5e…`, the same build on every WASI transport |
| Elixir Host | [`bench/message-layer/elixir`](../../bench/message-layer/elixir/): Elixir 1.20.4, OTP 29; Wasmex 0.15.1 (wasmtime 47.0.2, Cranelift `opt_level: :speed`); the sidecar on an Erlang Port, in Docker 29.8.0 (cgroup v2) for containment |
| C Host | [`bench/message-layer-c`](../../bench/message-layer-c/): Apple clang 21.0.0, Wasmtime C API 49.0.2, cJSON 1.7.19 |
| Results | [Elixir](../../bench/results/2026-10-10-2605c656-message-layer-elixir-darwin-arm64-apple-m5.md), [C](../../bench/message-layer-c/results/2026-10-10-2605c656-darwin-arm64-apple-m5.md) |

Both Hosts follow #532's method. Each latency figure is taken after warm-up from 5,000 samples, three times, and judged on the run with the median p50. Instantiation takes 5,000 instances per run, and memory takes 20. Each fault case is repeated 20 times, with 2,000 mutated corpus Scripts. The two Hosts define each figure the same way:

- **Capability call:** from receiving one `op` need to receiving the next. It is measured inside a Pump of 100 immediate `echo` calls, each answered at once with its argument, `{items: [i, "hello", true], count: 1}`.
- **Pump:** a `deliver` and a `pump` of an empty Handler, until its `run end`.
- **Instantiation:** from a compiled module, or a process spawn for the sidecar, to the `hello` reply.
- **Memory:** linear memory or RSS after `hello`, a Group, a small Script and one Pump.

The C Host faces the same fault and containment cases as the Elixir Host. The Elixir harness drives it through the C Host's `--serve` bridge: one instance in the wasmtime C API, with linear memory capped by the Store's limiter. Its latency and memory are measured inside the C Host, since the bridge's Port would add to them.

## Results

| Row | Elixir, Wasmex | Elixir, sidecar | C, wasmtime |
| --- | --- | --- | --- |
| Capability call p50 | 96.1 µs ✓ (≤ 500) | 25.0 µs ✓ (≤ 100) | 41.5 µs ✓ (≤ 50) |
| Pump p50 | 178.3 µs ✓ (≤ 250) | 43.1 µs ✓ (≤ 100) | 65.5 µs ✓ (≤ 100) |
| Instantiation p50 | 1.19 ms ✓ (≤ 50) | 4.33 ms ✓ (≤ 100) | 0.97 ms ✓ (≤ 50) |
| Memory per instance | 15.5 MiB ✓ (≤ 16) | 18.3 MiB ✓ (≤ 32) | 15.5 MiB ✓ (≤ 16) |
| Memory containment | ✓ | ✓ | ✓ |
| Payload, Brotli / raw | 2.04 / 12.1 MiB ✓ (≤ 3 / ≤ 25) | – | same module ✓ |
| Script faults | ✓ no instance lost | ✓ no instance lost | ✓ no instance lost |

**Tail latency.** No p99 is above 10× its p50, so none needed investigating. The largest ratio is the C Host's Capability call: 233.8 µs against 41.5 µs, 5.6×.

**Memory containment.** Three runaway Scripts grow a List, double a text, or grow a Script Variable. Each runs 20 times, under the default limits with a 128 MiB cap and under the conformance minimums with a 1 GiB cap. Every Run ended in its Limit Fault, and every instance passed its health check afterwards. That includes the sidecar under a cgroup limit, which saw no OOM events. Uncapped, a growing Script Variable takes Wasmex's and the C Host's linear memory to about 1,250 MiB. Under the 1 GiB cap the same Script still ends in its Persistent State Limit Fault, with linear memory at about 613 MiB.

**Script faults.** Every case lost nothing on any transport, and every instance answered `hello` and ran a fresh Script afterwards:

- Fuel, allocation, Persistent State and call depth Limit Faults, and deep recursion at the conformance minimum depth and at 1,000,000
- a full mailbox, `throw`, run-time errors, Operation failures and Host errors
- 44 pathological sources and 2,000 mutated corpus Scripts
- 37 malformed frames, and under WASI a `talk_send` length past its `talk_buffer` allocation

## What it took

#553's own run missed four rows on Wasmex and three on the sidecar, and the C Host ([#552](https://github.com/odogono/odgn-talk/issues/552)) was measured before the thresholds were set. These changes closed the gap:

| Found | Cause | Fixed in |
| --- | --- | --- |
| Deep nesting in source or frames crashed the Go Core | no depth guard; wasmtime's stack is far smaller than Go's native one | [#582](https://github.com/odogono/odgn-talk/issues/582), [#587](https://github.com/odogono/odgn-talk/pull/587) |
| Loading hostile source was quadratic, and the sidecar exited on a frame over 64 MiB | `FirstPos` rescans, retained token tapes | [#583](https://github.com/odogono/odgn-talk/issues/583), [#589](https://github.com/odogono/odgn-talk/pull/589) |
| Lists used 20–45× their Allocation Budget, so every memory cap broke | 312-byte `Value`s and slice copies | [#584](https://github.com/odogono/odgn-talk/issues/584), [#588](https://github.com/odogono/odgn-talk/pull/588) |
| Each `wasip1` instance kept 28 MiB after compiling the stdlib | the stdlib compiled once per process, and every instance is a process | [#585](https://github.com/odogono/odgn-talk/issues/585), [#591](https://github.com/odogono/odgn-talk/pull/591) |
| A 1,000,000-digit number in a frame lost the instance under its 1 GiB cap, on Wasmex and the C Host | `big.Int` conversion before the 34-digit check, quadratic in the digits | [#608](https://github.com/odogono/odgn-talk/issues/608), [#609](https://github.com/odogono/odgn-talk/pull/609) |
| The C Host's Capability call p50 was 52.2 µs, over its 50 µs | Trace text built on every call with no Trace, and a failed JSON decode on every integer field | [#611](https://github.com/odogono/odgn-talk/issues/611), [#613](https://github.com/odogono/odgn-talk/pull/613) |

Two harness faults also made rows read as misses when they weren't, and are fixed in this PR:

- **Sidecar containment:** the harness removed the container before its health check, so every sidecar containment row failed, even with no OOM event.
- **Brotli:** the harness hard-coded the Brotli size of the first reactor build, so later builds showed "not measured". It now runs the Brotli CLI.

The C Host is also extended in this PR:

- **The thresholds:** it now takes #532's figures as defined above, as well as its earlier descriptive ones.
- **A bridge:** it serves one instance to the Elixir Host's fault and containment suites.
- **A finer clock:** on macOS it reads `mach_absolute_time`, because `CLOCK_MONOTONIC` resolves only to whole microseconds there.

## Margins

- **Memory per instance under WASI: 15.5 MiB against 16 MiB,** on both Wasmex and the C Host. Linear memory grows in 64 KiB pages, and this is 248 pages against 256, so a change that adds half a mebibyte to a fresh instance's Go heap misses the row. #532's thresholds have no regression check, so nothing would notice. Re-run either harness after changes to Load, the stdlib or the Message Layer.
- **The C Host's Capability call: 41.5 µs against 50 µs.** Before #613 the same figure was 46.5 µs in one session and 52.2 µs in another, about 12% apart on the same commit. A future miss of a few percent may be noise, so judge it on more than one session.
- **Wasmex's Pump: 178.3 µs against 250 µs.**

The other rows pass by a factor of two or more.

## Fog

- **One machine.** Every figure is from one Apple M5 on macOS. Linux on x86-64, where wasmtime and Go's `wasip1` port differ, isn't measured. Neither is a smaller machine.
- **Only immediate Operations are timed.** Suspending Operations, `prop` needs, restore and the Message Layer's unsupported messages aren't timed.
- **Finite cases, not a proof.** The fault cases are evidence, not a guarantee that no hostile input can trap an instance.
- **A minimal C Host.** It uses cJSON and is not a reusable C binding. A real one could add to the per-call cost the C row is judged on.

## Reproducing

```sh
bench/message-layer-c/run.sh                  # C Host figures, and builds out/host for the bridge
cd bench/message-layer/elixir && mix deps.get
mix talk.measure --build                      # Wasmex, sidecar and the C Host's bridge: about 40 minutes
```

The Elixir run needs Docker for the sidecar's containment, and the C Host needs Wasmtime's C API (`brew install wasmtime brotli`). The [C harness guide](../../bench/message-layer-c/README.md) and the [Elixir harness guide](../../bench/message-layer/elixir/README.md) define each figure.
