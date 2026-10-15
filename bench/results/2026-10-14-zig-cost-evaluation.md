# Zig Cost Model formula specialization

Generated static charge evaluators reduce median paired Run time by 9.3% for loops, 10.8% for addition, 11.2% for calls and 5.6% for Quantity on this Apple M5. All measured outputs, Fuel and logical allocation agree with the baseline. This implements the optimization in [#935](https://github.com/odogono/odgn-talk/issues/935).

## Implementation and fallback

`tools/zig/generate.ts` derives charge formulas only from `spec/data/costs.toml`, through the existing Cost Model compiler. It emits 34 shared Fuel/allocation formula evaluators for 44 static rates alongside the unchanged interpreter terms. Each term retains its own ceiling division, factor multiplication, checked u64 operations and accumulation order. Even divisor-one terms retain the interpreter's `n + d - 1` arithmetic. No rate constants are copied into the machine by hand.

`chargeInstruction` uses the pre-resolved opcode rate's generated formula. The 55 Built-in rates and keyed charges still use the term interpreter; a formula with an unsupported subject or measure is generated with a null evaluator and follows that same fallback. Missing rates still charge zero, including extras. Built-in name overrides, oversized-name fallback and restricted-refusal selection keep their existing precedence. The measure selector is inlined so a generated measure code selects its branch ahead of execution. The coefficient-digit algorithm is unchanged; no digit-helper optimization is included in these timings.

The machine's charge sites, pre-Host checks, reached-Host charge retention, failed-result re-evaluation, Fuel/allocation refusals, cancellation, cleanup, preemption and fault boundaries are unchanged. Charges are still applied at each instruction boundary, and the optimization adds no code-unit, frame, Run or snapshot state.

## Measurement conditions

Baseline Core: `f51ad856`. Optimized Core: the issue-935 implementation on that base; the [raw paired results](2026-10-14-zig-cost-evaluation.json) pin the binaries, Core/Host source hashes, generator, rates and manifest. Platform: macOS-27.0.1-arm64-arm-64bit-Mach-O; Apple M5; Zig 0.17.0 `safe`; C Host `cc -std=c11 -O2 -Wall -Wextra -Werror`; language 1.0-rc.3, Cost Model 0.

The [intake](2026-10-14-zig-cost-intake.json) captured loops, addition, calls, Quantity and sliced execution before Core edits. Both intake lanes use the same baseline binary; their before/after labels denote repeated baseline captures. Paired optimization timings use three rounds in before/after, after/before, before/after order, five samples per process, all 26 supported manifest workloads, the Fibonacci Fuel Slice sweep, sliced loops/calls and four instruction probes: 36 workloads and 108 pairs. Builds and conformance checks finished before the published paired run. The Host validates one Run before timing and checks every timed Run; each pair also includes separate untimed counting-allocator probes. Load/destruction are outside Run timing.

The change column below is the median of each pair's after/before ratio minus one. The range shows the three individual pair changes. Absolute timings vary across rounds on the shared host, so the paired ratios are the principal evidence. These measurements show reductions in execution time, rather than promising the whole sampled charging share is removable.

## Native paired timings

| Workload | Fuel Slice | Median change | Pair change range |
| --- | ---: | ---: | ---: |
| `core/loop` | unlimited | -9.3% | -10.4% to -6.2% |
| `core/loop` | 100 | -7.5% | -10.9% to -3.4% |
| `core/fib` | unlimited | -9.2% | -10.3% to -8.5% |
| `core/fib` | 10 | -1.3% | -3.3% to -0.4% |
| `core/fib` | 100 | -5.8% | -6.7% to -5.7% |
| `core/fib` | 1000 | -6.8% | -8.4% to -4.0% |
| `core/fib` | 10000 | -7.3% | -9.3% to -3.5% |
| `core/calls` | unlimited | -11.2% | -11.7% to -10.1% |
| `core/calls` | 100 | -6.1% | -8.8% to -3.1% |
| `core/lambdas` | unlimited | -9.7% | -9.9% to -6.3% |
| `numbers/add` | unlimited | -10.8% | -11.2% to -10.1% |
| `numbers/multiply` | unlimited | -11.2% | -22.0% to -5.1% |
| `numbers/divide` | unlimited | -8.5% | -9.0% to -8.2% |
| `numbers/quantity` | unlimited | -5.6% | -7.0% to -5.6% |
| `text/build` | unlimited | -5.0% | -7.5% to -2.6% |
| `text/iterate` | unlimited | -8.5% | -9.5% to +25.0% |
| `text/index` | unlimited | -5.4% | -14.6% to -3.3% |
| `text/patterns` | unlimited | -1.3% | -3.0% to +0.6% |
| `text/graphemes` | unlimited | -7.7% | -8.2% to -7.0% |
| `collections/list-build` | unlimited | -10.0% | -24.4% to -9.4% |
| `collections/list-append` | unlimited | -15.8% | -22.8% to -11.5% |
| `collections/map-build` | unlimited | -3.8% | -3.9% to +1.8% |
| `collections/list-update` | unlimited | -11.4% | -12.6% to -7.6% |
| `collections/map-update` | unlimited | -8.5% | -9.0% to -6.5% |
| `collections/iterate` | unlimited | -12.1% | -14.2% to -10.9% |
| `host/pump` | unlimited | -0.2% | -3.5% to +10.5% |
| `macro/transform` | unlimited | -11.2% | -12.0% to -8.8% |
| `macro/report` | unlimited | +2.9% | -2.1% to +5.5% |
| `macro/game-tick` | unlimited | -6.0% | -7.2% to +0.8% |
| `messaging/suspend` | unlimited | -0.3% | -3.6% to +5.3% |
| `lifecycle/load-small` | unlimited | -3.5% | -15.0% to +0.3% |
| `lifecycle/load-large` | unlimited | -1.7% | -13.1% to +6.0% |
| `probe/straightline` | unlimited | -6.3% | -12.2% to -4.2% |
| `probe/straightline` | 100 | -7.4% | -9.8% to -2.1% |
| `probe/protected-loop` | unlimited | -4.7% | -7.7% to -3.3% |
| `probe/protected-loop` | 100 | -5.2% | -5.6% to -2.8% |

`macro/report` initially measured +2.9%. Its [five-pair recheck](2026-10-14-zig-cost-report-recheck.json), with ten samples per process, measured -0.42% median change (range -2.41% to +8.56%). The slowdown did not reproduce consistently. `text/iterate` had a +25% outlying third pair despite an 8.5% median reduction; the raw observations remain included. Near-zero Pump and Load changes are treated as noise. No repeatable broad regression is established by this run.

## Charging profiles

Separate two-second macOS `sample` captures at 1 ms intervals count only stacks beneath `talk_pump`. Inclusive categories overlap. Generated evaluators inline into `chargeInstruction`, so their work is counted in charging, while the generic formula evaluator remains separately attributable. Compressed raw reports are in [the profile directory](2026-10-14-zig-cost-profiles); the [profile JSON](2026-10-14-zig-cost-profiles.json) retains sample counts and hashes.

| Workload | Fuel Slice | Charging before | Charging after | Generic evaluation before | Generic evaluation after |
| --- | ---: | ---: | ---: | ---: | ---: |
| `core/loop` | unlimited | 20.1% | 11.2% | 15.6% | 0.0% |
| `core/loop` | 100 | 14.3% | 8.2% | 11.5% | 0.0% |
| `core/calls` | unlimited | 15.0% | 7.7% | 11.9% | 0.0% |
| `core/calls` | 100 | 10.5% | 6.0% | 7.8% | 0.0% |
| `numbers/add` | unlimited | 19.1% | 9.8% | 14.9% | 0.0% |
| `numbers/quantity` | unlimited | 14.4% | 5.6% | 11.9% | 0.0% |

## Remaining AppleScript gaps

The [fresh four-way comparison](2026-10-14-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua-cost-evaluation.md) uses only native Zig, the TS Core, AppleScript and GopherLua. Zig and the peers use three repeats, and TS uses automatic mitata sampling. Zig and TS Fuel agree. Peers use idiomatic ports and native numeric types, so their times compare whole workloads rather than exact Decimal algorithms. The shared native regression run and the peer comparison are separate measurements.

| Workload still slower than AppleScript | Zig Run ms | AppleScript Run ms | Zig / AppleScript |
| --- | ---: | ---: | ---: |
| `core/loop` | 0.942 | 0.207 | 4.55x |
| `core/fib` | 0.702 | 0.540 | 1.30x |
| `core/lambdas` | 0.847 | 0.822 | 1.03x |
| `numbers/add` | 0.462 | 0.304 | 1.52x |
| `numbers/multiply` | 0.299 | 0.227 | 1.32x |
| `numbers/divide` | 0.333 | 0.245 | 1.36x |
| `numbers/quantity` | 0.374 | 0.155 | 2.41x |
| `collections/list-update` | 0.514 | 0.488 | 1.05x |

Formula specialization leaves Decimal arithmetic, value construction, ownership, call storage and language semantics in place. CPU attribution is not an estimate that those remaining costs can all be removed. The native Host's unsupported Capability and messaging bindings remain the documented [benchmark runner limitations](../README.md#native-zig-comparison).

## Verification

- `zig build test --summary all`: 230 tests pass, plus the C Host executable. Differential tests compare every generated rate with the independent interpreter across independently absent/populated inputs/results, missing argument prefixes, all value measures exercised by the rates, Decimal and Quantity digit boundaries through 34 digits, text/Bytes/List sizes around divisors, Unicode text, Maps, forward/backward Ranges and Patterns. Measures cover zero, ceiling boundaries, 2^56 and 2^62 boundaries, near-u64-max extras, restricted refusals, Built-in overrides, missing-rate behavior and reached-Host/failed-result re-evaluation.
- All 429 Corpus cases pass natively and with deferred Host crossings. All 429 also pass through a `safe` WASI Corpus Host in Wasmtime. Trace Cases include ordinary and save/restore-between-Pumps replays. Blessed expectations are unchanged.
- `zig build -Dtarget=wasm32-wasi`, `uv run tools/wasi/zig.py` and `uv run tools/wasi/check.py` pass, including physical-cap containment, recovery and Message Layer checks. The temporary WASI Corpus Host uses the [existing reproduction commands](2026-10-14-zig-instruction-bookkeeping.md#validation) with its own `.cache/issue-935-wasi-corpus` directory; it changes only the test Host's Corpus path and uses translated WASI C headers and an 8 MiB stack.
- Both TS/Zig fuzz-worker tests pass with 33 assertions. Generated-table/API checks, `zig fmt --check impl/zig`, generator tests, `bun run check`, workspace typechecking, lint, formatting and `git diff --check` pass.

## Reproduction

Build `bench/zig/host.c` with the above flags against the baseline and optimized native static libraries, then run from the repository root:

```sh
python3 bench/zig/instruction-bookkeeping.py <before-host> <after-host> --before-revision f51ad856 --pairs 3 --count 5 --out <timings.json>
python3 bench/zig/instruction-bookkeeping.py <before-host> <after-host> --before-revision f51ad856 --pairs 5 --count 10 --filter macro/report --out <recheck.json>
python3 bench/zig/instruction-bookkeeping.py <before-host> <after-host> --before-revision f51ad856 --profiles-only --profiles <profile-directory> --profile-filter core/loop --profile-filter core/calls --profile-filter numbers/add --profile-filter numbers/quantity --out <profiles.json>
bun run bench --only zig,ts,applescript,gopher-lua --count 3 --no-save
```

No Spec change or new blessed expectation is proposed. Normal implementation review remains before merge.
