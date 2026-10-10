# Where each Fuel unit's time goes, in both Cores

Answers [#533](https://github.com/odogono/odgn-talk/issues/533), raised in [#122](https://github.com/odogono/odgn-talk/issues/122). It profiles `core/fib`, `core/calls` and `collections/map-build` on both Cores, attributes the time and host allocation to the mechanisms that cause it, and proposes fixes that keep parity. Performance is outside parity ([ADR 0009](../adr/0009-twin-cores-held-to-bit-for-bit-parity.md)), and benchmarks only advise the Cost Model ([ADR 0054](../adr/0054-benchmarks-live-outside-the-cores-and-only-advise-the-cost-model.md)). None of the fixes changes a Fuel charge, a logical allocation or a Trace.

## Summary

- **The issue's framing is only half right.** The per-step machinery it names does cost something: Fuel checks, run accounting, allocation measurement and Segment rollback state. But on these workloads the largest costs are plain implementation slow paths, and they are cheap to remove:
  - **Go re-parses Cost Model formula text on every charge.** `Charge` scans the rate table for the key, then splits and parses its formula strings with `strings.Split`, `strings.Fields` and `strconv`. That is 26–28% of Run time on `core/fib` and `core/calls`, and about a quarter of their host allocations.
  - **TS decimal arithmetic takes a slow path on every small integer.** `result` scales 610 up to 34 digits, then finds the exponent by computing up to 32 powers of ten as fresh BigInts. The result is then formatted to text and parsed back through `dec`, which scans grapheme boundaries to trim white space. Arithmetic is 64% of `core/fib` and 56% of `core/calls`.
  - **Both Cores rebuild a whole Map on every key write.** Go re-normalises and re-checks every key and builds a Go `map` for the duplicate check. TS copies every pair, then freezes each one again. Each write is O(n) with a large constant, so `map-build` is O(n²).
- **Prototypes of the fixes passed every Core test, the corpus gate and the Fuel parity smoke run.** Go runs 16–70% faster with 72–84% fewer host allocations. TS runs 48–62% faster. Fuel and logical allocation stayed the same.
- **What's left after the prototypes is the per-step design.** Cost Model evaluation remains the largest cost in both Cores: 17% of Run in Go, 24% in TS. It is followed by string dispatch on instruction names, Go's trial frame copy, and TS's depth recount on every call. The fixes for these are larger. They are listed under [the remaining per-step costs](#the-remaining-per-step-costs).
- **Per-Fuel cost is still well above the peers after the fixes.** Go's `core/fib` drops from 72 to 53 ns per Fuel unit, and TS's from 244 to 92. gopher-lua runs `core/fib` in 0.073 ms, about 34 times faster than the Go prototype. This supports [ADR 0071](../adr/0071-a-third-core-serves-embedding-outside-go-and-ts-after-the-message-layer-is-measured.md): speed isn't a reason for a third Core, because the gap lies in the shared design rather than the host language.

## Setup

| | |
|---|---|
| Commit | `0701253a` on `main` |
| Machine | Apple M5, 10 cores, 24 GiB, darwin arm64 |
| Go | 1.27.2, `go test -bench Run` in [`bench/go`](../../bench/go/), `-cpuprofile` and `-memprofile -memprofilerate 1` |
| TS | Bun 1.4.2, `bun --cpu-prof` on a loop that calls `Loaded.run` from [`bench/ts/src/suite.ts`](../../bench/ts/src/suite.ts) for 3–4 s after 20 warm-up Runs |

Go times are medians of 5 `-count` runs of 2 s each, compared with `benchstat` (p = 0.008 for every timing difference reported). TS times are the median Run over 3–4 s. TS Runs varied by up to 2× between processes on a machine with other load, so read TS figures to about ±15%. The Run phase is one `run n` Delivery and its Pumps on an already loaded Script, as [the Benchmark Suite](../../bench/README.md#what-is-measured) defines it.

At this commit the Go Core is already faster than in the [2026-10-08 results](../../bench/results/2026-10-08-darwin-arm64-apple-m5.md) the issue quotes: `core/fib` takes 3.3 ms rather than 5.2 ms, and allocates 1.9 MiB rather than 3.4 MiB. Go changes have landed since then, including [#588](https://github.com/odogono/odgn-talk/pull/588) and [#589](https://github.com/odogono/odgn-talk/pull/589). This note doesn't bisect the cause. TS is unchanged at about 10 ms.

## Go Core

### Attribution at `0701253a`

Shares are of Run CPU time (`(*Group).runPump` inclusive), from the CPU profiles. Allocation shares are of host allocations inside `runPump`.

| Mechanism | `core/fib` | `core/calls` | Where |
|---|---:|---:|---|
| Cost Model evaluation (`Charge`, `formula`, `measure`) | 36% | 36% | [`cost.go`](../../impl/go/internal/machine/cost.go) |
| …of which parsing formula text | 26% | 26% | `strings.Split`, `strings.Fields`, `strconv.ParseInt` in `formula` |
| …of which the `digits` measure | 8% | 7% | `Number.String()` builds a `big.Int` from the coefficient text, prints it, then trims it |
| Instruction semantics (`evaluate`) | 33% | 30% | [`instruction.go`](../../impl/go/internal/machine/instruction.go) |
| …of which the arithmetic operator map | 9% | 5% | a `map[string]string` literal built on every `add`/`subtract` |
| Trial frame copy and copy-back (Segment rollback) | 10% | 10% | `ExecuteHosted`: stack, locals and `maps.Clone(ReceiverNames)` per instruction |
| Dispatch checks (`Supported`, `foreignWaitCall`, `propertyRequest`, `preflight`, `i.Name` comparisons) | 13% | 16% | [`run.go`](../../impl/go/internal/machine/run.go) |
| Fuel checks (`pay`) | 2% | 1% | |
| Run accounting (`flushAccounting`, per Pump) | <1% | <1% | [`group_run.go`](../../impl/go/group_run.go) |
| Garbage collection, in background CPU beside the Run | 13% | 8% | `runtime.gcDrain`, as a share of Run time |

In `collections/map-build`, `mapWrite` and `value.NewMap` account for 71% of Run time and 86% of allocated bytes. The rest of the profile is mostly garbage collection of the copies.

Host allocations per Run:

| Source | `core/fib` | `core/calls` | `map-build` |
|---|---:|---:|---:|
| `evaluate` closures that escape: `name`, captured by one `choose-offer` effect | 31% | 48% | 33% |
| `evaluate` result values that escape: `bad := func(v) { err = &v }` moves every inlined `v` to the heap | (in the row above) | | |
| Formula parsing | 33% | 21% | 26% |
| `digits` measure (`big.Int`, `strings.Reader`) | 9% | 7% | 3% |
| `NewMap`, `slices.Clone` of pairs | | | 16% |
| Boxing values (`Fields.Value`) and argument copies | 7% | 10% | 5% |

The two escape problems are compile-time facts, so `go build -gcflags=-m ./internal/machine` shows them. The `name` closure escapes because one branch, `choose-offer`, captures it in its effect. As a result, every `evaluate` call allocates it. `bad` is inlined, and its `&v` makes the compiler move the caller's `v` to the heap. That variable is the success value too, so every arithmetic and comparison result is heap-allocated, even when nothing fails.

### Prototype fixes

| Fix | Change |
|---|---|
| G1. Parse each Cost Model formula once | Parse each formula into terms at package init, and look a rate up by key in a map. `formula` then only evaluates. The better long-term form is for the [Go generator](../../tools/go/generate.ts) to emit parsed terms in [`costs.go`](../../impl/go/internal/generated/costs.go). |
| G2. Count `digits` from the coefficient | Add `decimal.Number.Digits()`, the coefficient text's length without its sign and leading zeros. It is the same count `String()` gave after trimming. |
| G3. Hoist the arithmetic operator map | Use a package-level `map[string]string`. |
| G4. Stop `evaluate`'s closures escaping | `choose-offer` copies `name(0)` into a local before capturing it. `bad` allocates the error separately: `err = new(value.Value); *err = v`. |
| G5. Write one Map key without rebuilding the Map | Normalise only the written key. Clone the pairs, set or delete one of them, and build the result with `WithEntries`. The whole Map's keys are already normal and distinct. |

| Benchmark | Before | After | Change | Allocs before → after | Bytes before → after |
|---|---:|---:|---:|---:|---:|
| `core/fib` | 3.346 ms | 2.468 ms | −26% | 58,078 → 9,035 | 1.91 MiB → 0.64 MiB |
| `core/calls` | 3.283 ms | 2.759 ms | −16% | 56,021 → 16,009 | 2.03 MiB → 1.01 MiB |
| `collections/map-build` | 3.774 ms | 1.148 ms | −70% | 21,705 → 3,956 | 9.04 MiB → 2.64 MiB |

G1–G4 give the `core/*` gains. G5 alone gives most of `map-build`'s. Fuel and logical allocation were identical in every sample. `go test ./internal/machine ./internal/decimal .` and `go run ./cmd/corpus --check-passing` passed.

## TS Core

### Attribution at `0701253a`

Shares are of Run CPU time (`turn` inclusive), from the Bun CPU profiles.

| Mechanism | `core/fib` | `core/calls` | Where |
|---|---:|---:|---|
| Decimal arithmetic (`arithmetic` inclusive) | 65% | 56% | [`operations.ts`](../../impl/ts/src/operations.ts), [`decimal.ts`](../../impl/ts/src/decimal.ts) |
| …of which `result` and `pow10` | 52% | 37% | `result` rounds every exact value as if it needed rounding |
| …of which `numberValue` → `dec` re-parsing | 8% | 16% | `dec` runs `trimWhiteSpace`, which scans grapheme boundaries, then a regex and `literalDigits` |
| Cost Model evaluation (`pay`, `charge`) | 10% | 10% | [`costs.ts`](../../impl/ts/src/costs.ts). Formulas are pre-parsed, but every charge builds a `subject` closure and may run a regex |
| `digits` measure | 7% | 6% | `parseDec(n.toString()).coefficient.toString().length` |
| Depth check (`realDepth`) | 5% | 3% | [`machine.ts`](../../impl/ts/src/machine.ts) builds arrays and a `Set` over every frame on every call. Go caches the depth (`depthValid` in [`depth.go`](../../impl/go/internal/machine/depth.go)) |
| Interpreter loop (`step`, `execute`, `finishInstruction`) | ~10% | ~11% | |

TS has no Segment rollback copy per instruction. It charges before an instruction changes anything ("Charge, then replace"), where Go evaluates on a trial frame and charges afterwards.

In `collections/map-build`, `setKey` → `map` is 56% of Run time, and `Object.freeze` alone is 47%. `setKey` copies every pair through `entries()`, and `map` re-normalises, re-checks and re-freezes them all. Cost Model evaluation is another 18%, because the logical size of each new Map is recomputed from its children. `cacheListExtension` already records the size of a List that `extendList` grows; nothing records a Map's.

### Prototype fixes

| Fix | Change |
|---|---|
| T1. Keep an exact result's ideal exponent | In `add` and `multiply`, when the exact coefficient is under 10³⁴ and its ideal exponent is in range, return it directly. This is the exponent `result` would choose. A value that fits 34 digits needs no rounding, and the ideal exponent lies between the finest and coarsest exact writings. |
| T2. Cache powers of ten | Use a table of `10n ** k` for k < 70. |
| T3. Build arithmetic results without re-parsing | Add an internal `canonicalNumber(text)` that wraps `formatDec`'s output directly. `numberValue` uses it when the coefficient is under 10³⁴ and the exponent is at least −6176, and keeps `dec`'s checks otherwise. |
| T4. Write one Map key by sharing the other pairs | Add internal `mapPairs()` and `mapWithEntry(map, nfcKey, value)`. They slice the frozen pairs, replace or append one, and freeze only the new pair and the array. |

| Benchmark | Before | After | Change |
|---|---:|---:|---:|
| `core/fib` | 11.3 ms | 4.3 ms | −62% |
| `core/calls` | 9.7 ms | 4.7 ms | −52% |
| `collections/map-build` | 18.2 ms | 9.5 ms | −48% |

`bun test` in `impl/ts` passed, and `bun run bench --smoke` passed with matching Fuel on every Benchmark. After T4, `map-build` is still O(n²). Half its remaining time is freezing the copied array, and a third is re-sizing the new Map.

## The remaining per-step costs

These are the costs the issue names. They are now the largest in both Cores, and each needs a larger change. They are ordered by expected gain.

1. **Evaluate Cost Model charges without looking anything up.** Even with formulas parsed, each charge finds its rate by string key and dispatches on measure names. Lowering could store a rate index on each instruction. The generators could also emit each rate as a compiled function or a small array of `(measure, subject, factor, divisor)` codes, the same in both Cores. This is 17% of Go's Run after G1 and 24% of TS's after T1–T3. It needs no Spec change, because it only changes where the same formula is evaluated.
2. **Dispatch on an integer opcode.** Both loops compare `i.Name` strings many times per step. Go's `ExecuteHosted` alone tests `i.Name` in about ten conditions before `evaluate`'s own `switch`. Lowering emits a fixed set of instruction names, so it could also carry each one as an integer and turn these into one switch. This is internal, and the disassembly text and Traces keep their names.
3. **Copy only what an instruction touches (Go).** The trial frame copies the stack, the locals and the receiver-name map on every instruction, so that a failed charge leaves nothing behind. That is about 10% of `core/*` Run time. Two cheaper approaches are to check the charge before evaluating, as TS does, for the instructions whose measures don't depend on their result, or to copy lazily on first write. Either one keeps the rule that nothing commits before the charge succeeds.
4. **Cache the depth (TS).** Maintain the depth incrementally as Go does, or skip the recount when frames, retained frames and cancellation owners together number fewer than the Depth Limit.
5. **Store numbers as integers when they fit.** Both Cores keep a Number's coefficient as decimal text: Go in `decimal.Number.coefficient`, and TS in `Decimal`'s canonical string. Every operation parses it again: `strconv.ParseInt` in Go's `calculateSmall`, and `parseDec` → `BigInt` in TS. A cached `int64` or `bigint` beside the text would remove that work. It changes no observable value, because display, equality and Value Encoding still use the canonical text.
6. **Give Maps and Lists structural sharing.** Copy-on-write makes repeated writes O(n²) in both Cores. A persistent map, such as a HAMT with insertion order kept, or in-place mutation when the Core can prove the old Map is unreachable, would make each write O(log n) or O(1). Logical size must still be charged as if nothing were shared, as chapter 8 requires. TS already caches a grown List's size this way, through `cacheListExtension`.

## Follow-up issues

Each fix keeps parity, so each can land in one Core without the other.

- [#592](https://github.com/odogono/odgn-talk/issues/592): the Go slow paths, G1–G5.
- [#593](https://github.com/odogono/odgn-talk/issues/593): the TS slow paths, T1–T4, and caching the depth (remaining cost 4).
- [#594](https://github.com/odogono/odgn-talk/issues/594): remaining cost 1, Cost Model charges without lookups.
- [#595](https://github.com/odogono/odgn-talk/issues/595): remaining cost 2, integer opcodes.
- [#596](https://github.com/odogono/odgn-talk/issues/596): remaining cost 3, Go's trial frame copy.
- [#597](https://github.com/odogono/odgn-talk/issues/597): remaining cost 5, integers beside canonical Number text.
- [#598](https://github.com/odogono/odgn-talk/issues/598): remaining cost 6, structural sharing for Maps and Lists.

Costs 1 and 2 touch the generators and lowering, so they benefit from landing in both Cores together.

[`TestCoreRunAllocationBudgets`](../../bench/go/allocation_test.go) should lower its ceilings after the Go fixes land, so the allocation savings can't regress unnoticed.
