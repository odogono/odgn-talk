# Zig instruction bookkeeping — 2026-10-14

For [#879](https://github.com/odogono/odgn-talk/issues/879), CPU samples identify
repeated string lookup of instruction cost rates as material bookkeeping after
the Map and Decimal optimizations. Resolving the generated opcode-to-rate
mapping at compile time reduces median Run time by about 8% for loops and
straight-line moves, and 4% for calls and Fibonacci. Every unsliced target
improves in all three pairs. Instruction dispatch, safe checks and scheduling
retain their existing behavior.

## Base, method and uncertainty

The baseline is `bdc8f0e0fd09e2c49ff408f6d3fcdfa93ed2f76a`, containing #875,
the Map changes and the Decimal fast paths, plus subsequent fixes. The after
binary contains the uncommitted `machine.zig`/`costs.zig` change in this report;
the [raw measurements](2026-10-14-zig-instruction-bookkeeping.json) record both
binary hashes and baseline/after source hashes. The experiment uses Apple M5,
macOS 27.0.1, Zig 0.17.0's default `safe` mode and the same C Host at `-O2`.
Language 1.0-rc.3 and Cost Model 0 remain authoritative.

The [intake](2026-10-14-zig-instruction-intake.json), measured before editing
Core code, gives medians of 1.648 ms for loops, 1.105 ms for calls, 1.079 ms
for Fibonacci and 0.0233 ms for straight-line moves. Fibonacci's slice
10/100/1000/10000 medians are 5.242/1.476/1.128/1.049 ms. This re-establishes
the local baseline after arithmetic changes rather than relying on #875's
older timings.

Each recorded pair uses five samples per process, each averaging complete
Runs over at least 50 ms after an untimed output/accounting validation.
Load/compilation are outside the Run timer. Binary order alternates across
pairs. Counting-allocator probes and CPU profiles are separate from timings.
No builds or tests from this thread ran during the recorded measurements.
Other work was active on the machine; these are advisory results with timing
spread, not isolated-machine estimates or confidence intervals.

## Profile attribution

Profiles sample each binary for two seconds at 1 ms intervals during repeated
Runs. Only stacks beneath `talk_pump` contribute to the percentages below;
Host Delivery, result formatting, Load and profile startup are excluded.
The [compressed raw reports](2026-10-14-zig-instruction-profiles/) retain
inclusive call trees, addresses and function offsets. The JSON aggregates
exclusive leaf samples through each named ancestor to avoid double counting
recursive frames. Categories overlap and must not be added together.

“Charging” includes named `charge*` and `evaluate` stacks, including evaluation
that optimization places outside a named charge frame. Instruction-body,
Decimal, Value-construction, scratch-reset and allocator categories remain in
the JSON. Allocator attribution includes alloc/free/resize/reset frames and
overlaps scratch reset. This is sampled function attribution, not a complete
partition of every inlined instruction operation.

| Workload | Pump samples before / after | Charging before | After | Scratch reset before | Decimal before | Allocator before |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `probe/straightline` | 1482 / 1469 | 26.8% | 13.9% | 6.2% | 0.0% | 7.3% |
| `core/loop` | 1506 / 1511 | 26.0% | 14.2% | 4.4% | 4.4% | 6.9% |
| `core/calls` | 1506 / 1510 | 24.2% | 13.3% | 4.2% | 1.7% | 10.5% |
| `core/fib` | 1508 / 1518 | 19.0% | 10.8% | 4.2% | 7.3% | 11.2% |
| `core/fib@slice=10` | 1419 / 1417 | 4.0% | 1.9% | 0.6% | 1.3% | 6.3% |
| `core/fib@slice=100` | 1482 / 1477 | 13.9% | 8.9% | 3.6% | 4.4% | 11.6% |
| `core/fib@slice=1000` | 1510 / 1505 | 20.0% | 10.4% | 3.2% | 7.6% | 11.3% |
| `core/fib@slice=10000` | 1516 / 1516 | 19.7% | 11.3% | 5.4% | 7.8% | 13.5% |
| `probe/protected-loop` | 1517 / 1509 | 21.8% | 12.9% | 5.1% | 3.4% | 8.7% |
| `probe/protected-loop@slice=100` | 1489 / 1484 | 17.3% | 9.8% | 4.0% | 3.1% | 7.4% |

The baseline's `charge +244` and `+272` samples correspond to generated-rate
binary-search entry reads and byte-by-byte key comparisons in native
assembly (`llvm-objdump --disassemble --demangle before`). The after binary
looks up ordinary instruction rates by opcode instead. Formula evaluation
still runs for every charge; dynamic Built-in names still take the keyed
path. The reduction in sampled charging work and paired Run times supports
this narrower optimization.

Fuel Slice 10 spends most Pump time outside `execute`: scheduling and reports
dominate its profile. Smaller slice timing improvements therefore should not
be read as a scheduler optimization. Scratch reset is measurable but smaller;
this change does not skip it. `Operands.take` is inlined, so its zero named
samples do **not** establish zero retention cost. The protected-loop probe
executes within a `finally` scope, including its operand protection; there is
no evidence here justifying removal of retention or cleanup checks.

## Paired timing results

Medians below are the median of three per-process medians, in milliseconds.
Pair speedups compare adjacent before/after processes. The protected loop uses
`repeat for each` inside `try/finally`; its counts differ from `core/loop`'s
`repeat while`. The straight-line probe performs 256 local-to-local moves.

| Workload | Before ms | After ms | Speedup | Pair speedups |
| --- | ---: | ---: | ---: | --- |
| `core/loop` | 1.5537 | 1.4258 | 1.09× | 1.11×, 1.08×, 1.09× |
| `core/loop@slice=100` | 2.0050 | 1.8638 | 1.08× | 1.06×, 1.13×, 1.08× |
| `core/fib` | 1.0255 | 0.9808 | 1.05× | 1.06×, 1.05×, 1.05× |
| `core/fib@slice=10` | 5.2609 | 4.8205 | 1.09× | 1.03×, 1.12×, 1.04× |
| `core/fib@slice=100` | 1.4897 | 1.4049 | 1.06× | 1.06×, 1.07×, 1.06× |
| `core/fib@slice=1000` | 1.0802 | 1.0030 | 1.08× | 1.06×, 1.06×, 1.08× |
| `core/fib@slice=10000` | 1.0520 | 0.9935 | 1.06× | 1.08×, 1.10×, 1.06× |
| `core/calls` | 1.0257 | 0.9850 | 1.04× | 1.07×, 1.05×, 1.04× |
| `core/calls@slice=100` | 1.5330 | 1.4608 | 1.05× | 0.97×, 1.05×, 1.05× |
| `core/lambdas` | 1.4707 | 1.3575 | 1.08× | 1.14×, 1.08×, 1.08× |
| `numbers/add` | 0.7817 | 0.7206 | 1.08× | 1.08×, 1.08×, 1.07× |
| `numbers/multiply` | 0.5042 | 0.4609 | 1.09× | 1.13×, 1.09×, 1.05× |
| `numbers/divide` | 1.0427 | 0.9719 | 1.07× | 1.03×, 1.04×, 1.13× |
| `numbers/quantity` | 1.2808 | 1.2495 | 1.03× | 1.03×, 1.02×, 1.03× |
| `text/build` | 0.4890 | 0.4882 | 1.00× | 1.02×, 1.05×, 0.96× |
| `text/iterate` | 0.8016 | 0.7568 | 1.06× | 1.06×, 1.07×, 1.07× |
| `text/index` | 1.5998 | 1.5855 | 1.01× | 1.01×, 1.02×, 1.02× |
| `text/patterns` | 0.6602 | 0.6916 | 0.95× | 0.95×, 1.00×, 1.03× |
| `text/graphemes` | 1.4735 | 1.3918 | 1.06× | 1.06×, 1.06×, 1.06× |
| `collections/list-build` | 0.8259 | 0.7842 | 1.05× | 1.05×, 1.03×, 1.04× |
| `collections/list-append` | 1.5224 | 1.3956 | 1.09× | 1.09×, 1.11×, 1.09× |
| `collections/map-build` | 0.9551 | 0.9482 | 1.01× | 1.01×, 1.02×, 1.02× |
| `collections/list-update` | 0.8716 | 0.8168 | 1.07× | 1.08×, 1.16×, 1.06× |
| `collections/map-update` | 0.2910 | 0.2720 | 1.07× | 1.07×, 1.08×, 1.07× |
| `collections/iterate` | 2.3726 | 2.1371 | 1.11× | 1.11×, 1.01×, 1.10× |
| `host/pump` | 0.0016 | 0.0016 | 1.01× | 0.99×, 1.01×, 1.04× |
| `macro/transform` | 0.7074 | 0.7116 | 0.99× | 0.99×, 1.05×, 1.04× |
| `macro/report` | 1.2506 | 1.2878 | 0.97× | 0.98×, 1.02×, 0.97× |
| `macro/game-tick` | 1.8397 | 1.7207 | 1.07× | 1.07×, 1.09×, 1.08× |
| `messaging/suspend` | 3.3447 | 3.1545 | 1.06× | 1.17×, 1.01×, 1.04× |
| `lifecycle/load-small` | 0.0017 | 0.0017 | 1.05× | 1.01×, 1.01×, 1.15× |
| `lifecycle/load-large` | 0.1901 | 0.1777 | 1.07× | 1.07×, 1.08×, 1.08× |
| `probe/straightline` | 0.0197 | 0.0181 | 1.08× | 1.08×, 1.11×, 1.08× |
| `probe/protected-loop` | 0.6453 | 0.5956 | 1.08× | 1.06×, 1.05×, 1.09× |
| `probe/protected-loop@slice=100` | 0.8521 | 0.8489 | 1.00× | 0.99×, 1.04×, 1.04× |

Some small broader-workload changes do not reproduce. The first comparison's
text-pattern median is 4.8% slower and macro/report 3.0% slower. A separate
[five-pair recheck](2026-10-14-zig-instruction-regression-check.json), with ten
samples per process and alternating order, measures text patterns at
0.6683 → 0.6450 ms (3.5% less time) and macro/report at
1.2387 → 1.2393 ms (effectively unchanged). Macro/report's recheck contains
both faster and slower pairs. There is no repeatable material regression in
these measurements. Sliced calls and protected loops likewise contain mixed
pairs; the smaller effects are noisy. The unsliced target gains reproduce
in every pair. The nine manifest workloads unsupported by this benchmark Host
remain outside this comparison, as the [suite guide](../README.md#native-zig-comparison)
describes.

## Charging, retention and memory equivalence

`costs.zig` builds a read-only array of rate pointers from the existing
generated instruction and cost tables at compile time. It adds no per-Group,
frame, instruction or snapshot fields. Missing-rate behavior and extra Host
charges use the same evaluator. Built-in overrides, restricted refusals and
the existing overlong-name fallback preserve keyed charging behavior. The
equivalence test compares every opcode with the original keyed path using
absent, Number, Text and List subjects, nonzero measurement/Host extras, and
dynamic overrides.

The execution loop still charges at the same boundaries, applies the same
clause Fuel and checks the same Run/cleanup budgets. Pre-Host admission,
landed cancellation/Stop, Group Stop and partial-result allocation faults use
the resolved rate without moving any check or charge. Canonical code and
positions, Pump preemption points, operand retention, failed continuation
stacks, pending cleanup control, unwind/offer dispatch, rollback and Save/Restore
are unchanged. Retained operands still survive until the existing deferred
release, including during failed instructions and cleanup.

All 105 comparisons across 35 workload/slice variants reproduce the same
output, exact Fuel and logical allocation on both binaries, including both
allocator probes. All probes also reproduce identical Group allocation
requests, cumulative requested bytes and Group peak memory. The static table
has no Group allocator requests or retained per-Group capacity. For example,
`core/loop` remains 48,016 Fuel / 64,000 logical bytes, calls
46,018 / 32,072, and Fibonacci at every slice 46,365 / 47,328.

The counting allocator records Group requests for one Delivery/Pump Run,
excluding Load and process-owned Host Values/returned bytes; frees do not
subtract. Group peak includes Load. It uses `posix_memalign` and differs from
the default allocator, so it diagnoses physical requests separately from
unmodified default-allocator timing.

## Reproduction

Build each revision with `zig build` in `impl/zig`, preserving the default
safe optimization, and save its compiled Host before rebuilding the other:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c impl/zig/zig-out/lib/libtalk.a -o /path/to/host
python3 bench/zig/instruction-bookkeeping.py /path/to/before /path/to/after \
  --before-revision bdc8f0e0fd09e2c49ff408f6d3fcdfa93ed2f76a \
  --pairs 3 --count 5 --profiles /path/to/profiles --out /path/to/results.json
python3 bench/zig/instruction-bookkeeping.py /path/to/before /path/to/after \
  --before-revision bdc8f0e0fd09e2c49ff408f6d3fcdfa93ed2f76a \
  --filter text/patterns --filter macro/report --pairs 5 --count 10 \
  --out /path/to/regression-check.json
```

## Validation

- `zig build test --summary all`: 177/177 tests pass, plus native C Host
  tests, covering the existing recovery, scheduling, cancellation/Stop,
  charging, limits and allocation-refusal behavior as well as the new rate
  equivalence test.
- `zig build corpus`: all 427 cases pass through `talk.h`, with both ordinary
  and between-Pump Save/Restore Trace replay. Recovery Offers, failed cleanup,
  cancellation, preemption, Limit Faults and retained-state accounting reproduce
  their existing records.
- The same Corpus Host, compiled with `-target wasm32-wasi -Osafe`, passes all
  427 cases in Wasmtime, including both Trace replays. A temporary copy of its
  Corpus source changes `../../corpus` paths to `corpus`, preopening the
  repository root. The Host uses translated WASI C headers and an 8 MiB stack;
  the Core sources are unchanged. Reproduce the test Host build below.
- `zig build -Dtarget=wasm32-wasi`, `uv run tools/wasi/zig.py` and
  `uv run tools/wasi/check.py`: safe reactor and Message Layer checks pass,
  including physical-cap containment and healthy fresh Groups after refusal.
- `bun test tests/zig-runner.test.ts` in `tooling/fuzz`: both tests pass,
  including witness/mutation agreement with complete TS Traces (33 assertions).
- Unicode preparation, generated tables, `bun run check`, `bun run lint`,
  `bun run format:check`, `zig fmt --check impl/zig` and the C API catalogue
  check pass. The Spec and blessed expectations have no changes.

For WASI Corpus replay, run from the repository root after building the
optimized checkout. These commands prepare only a temporary test Host:

```sh
out=.cache/zig-instruction-wasi
mkdir -p "$out"
cp -R impl/zig/src/corpus "$out/"
python3 -c 'from pathlib import Path; import sys; p=Path(sys.argv[1]); p.write_text(p.read_text().replace("../../corpus", "corpus"))' "$out/corpus/main.zig"
zig translate-c -target wasm32-wasi -lc impl/zig/include/talk.h > "$out/talk-c.zig"
zig build-exe -target wasm32-wasi -Osafe -lc --stack 8388608 \
  --dep northtalk --dep talk-c --dep session -Mroot="$out/corpus/main.zig" \
  -target wasm32-wasi -Osafe --dep talk.h -Mnorthtalk=impl/zig/src/root.zig \
  -target wasm32-wasi -Osafe -Mtalk-c="$out/talk-c.zig" \
  -target wasm32-wasi -Osafe --dep northtalk --dep talk-c --dep inspect-reader -Msession=impl/zig/src/session/root.zig \
  -Mtalk.h=impl/zig/include/talk.h -Minspect-reader=spec/session/inspect-reader.talk \
  -femit-bin="$out/corpus.wasm"
wasmtime run --dir . "$out/corpus.wasm"
```
