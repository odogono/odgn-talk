# Zig empty scratch reset — 2026-10-15

For [#956](https://github.com/odogono/odgn-talk/issues/956), skip the standard
instruction scratch reset when its arena is already empty and consolidated.
Across three alternating pairs, median paired Run time falls 4.9% for unsliced
loops, 6.1% for sliced loops and 4.7% for addition. A separate five-pair
calls/lambda recheck measures calls using 6.5% less Run time with and without slicing.
Outputs and exact accounting agree throughout. These are shared-machine
measurements with substantial spread, rather than isolated-machine estimates.

## Implementation and invariant

[`scratch.zig`](../../impl/zig/src/machine/scratch.zig) recognizes two fixed
points of Zig 0.17.0's `ArenaAllocator.reset(.retain_capacity)`: no used or
free buffers; or one used buffer with `end_index == 0`, no next buffer and
no free list. In those states, the standard reset would only recompute the
existing capacity and write back the same empty state. The fast path reads
that state and returns. Merely obtaining the scratch allocator does not
make it dirty. There is no wrapper on allocation, extra dirty bit, custom
buffer allocation policy or new Group/snapshot field.

Every other state uses the standard reset, including used buffers, chains,
free lists and failed allocation/consolidation. Tests cover empty arenas,
repeated boundaries, reuse after allocation and last-allocation free,
multi-buffer consolidation, refused preheating, refused subsequent growth
and a retained free-list buffer. The predicate intentionally depends on the
pinned standard-library arena state; a Zig upgrade must revisit it.

The only machine change replaces the existing reset call at the top of
`Group.execute`'s instruction loop. Clause charging, landing and held Trace
output, preemption, protected operands, per-instruction charge measures,
pre-Host admission, limits, failed continuations, cleanup and dispatch keep
their existing order. No Fuel charges or cancellation checks are batched.
Scalar lifetimes, Text measurement and charge formulas are unchanged.

## Base and method

Both binaries start at `0aed90d3`; the after binary adds only the
`machine.zig` reset call and `scratch.zig` helper. The
[paired measurements](2026-10-15-zig-scratch-reset.json) pin executable and
source SHA-256 hashes, including the new helper (null in baseline source
metadata). Conditions: Apple M5, macOS 27.0.1, Zig 0.17.0 native `safe`,
the identical C Host at `-O2`, language 1.0-rc.3 and Cost Model 0.

The [intake](2026-10-15-zig-scratch-intake.json) predates the Core edit.
Its before/after lanes are repeated captures of the **same baseline binary**,
not an optimization comparison. Scratch reset accounts for 117/1,544 and
118/1,536 unsliced loop Pump samples (7.6%/7.7%), and 114/1,559 and
119/1,533 addition samples (7.3%/7.8%). Loop charging is 12.1%/12.2%.

The full experiment has 36 workload/slice variants, three alternating pairs
and seven samples per process, each averaging complete Runs over at least
50 ms. Load/compilation and destruction are outside Run timing. The Host
validates output/accounting before timing and checks every timed Run.
Counting-allocator probes use separate untimed processes. CPU sampling runs
only after all timings finish. This thread's builds and conformance checks
finished before the paired measurements; other work was active on the host.

Each percentage below is the median of adjacent-process after/before ratios
minus one. Ranges give the three individual pair changes; raw JSON retains
every sample. Absolute times drift across rounds, so ratios of independently
aggregated absolute medians need not equal these paired ratios. Large
single-pair changes, particularly calls, should not be read as isolated
optimization gains.

## Paired Run results

| Workload | Fuel Slice | Median change | Pair change range |
| --- | ---: | ---: | ---: |
| `core/loop` | unlimited | -4.9% | -9.1% to -4.6% |
| `core/loop` | 100 | -6.1% | -7.5% to -5.2% |
| `core/calls` | unlimited | -11.4% | -30.2% to -5.5% |
| `core/calls` | 100 | -4.4% | -21.3% to -1.0% |
| `core/fib` | unlimited | -4.1% | -4.5% to +16.2% |
| `core/fib` | 10 | +0.4% | -1.4% to +0.8% |
| `core/fib` | 100 | -1.6% | -3.8% to -0.7% |
| `core/fib` | 1000 | +0.2% | -1.9% to +0.4% |
| `core/fib` | 10000 | -1.3% | -6.9% to -0.3% |
| `core/lambdas` | unlimited | +2.1% | -4.4% to +5.5% |
| `numbers/add` | unlimited | -4.7% | -9.3% to -4.3% |
| `numbers/multiply` | unlimited | -1.3% | -8.5% to +0.8% |
| `numbers/divide` | unlimited | -2.2% | -5.9% to +1.6% |
| `numbers/quantity` | unlimited | -0.5% | -3.3% to +0.4% |
| `text/build` | unlimited | -4.4% | -5.3% to -1.0% |
| `text/iterate` | unlimited | -4.6% | -13.7% to -3.7% |
| `text/index` | unlimited | -3.5% | -4.4% to -3.0% |
| `text/patterns` | unlimited | -2.2% | -2.4% to -1.6% |
| `text/graphemes` | unlimited | -3.4% | -6.3% to -2.7% |
| `collections/list-build` | unlimited | -7.6% | -11.8% to -6.7% |
| `collections/list-append` | unlimited | -6.5% | -6.7% to -1.7% |
| `collections/map-build` | unlimited | +0.4% | -6.0% to +1.6% |
| `collections/list-update` | unlimited | -6.1% | -9.2% to -5.5% |
| `collections/map-update` | unlimited | -4.3% | -4.6% to +4.8% |
| `collections/iterate` | unlimited | -7.5% | -10.3% to -6.1% |
| `host/pump` | unlimited | -0.4% | -1.8% to +17.6% |
| `macro/transform` | unlimited | -2.8% | -12.2% to -2.3% |
| `macro/report` | unlimited | -1.9% | -4.7% to +8.2% |
| `macro/game-tick` | unlimited | -4.0% | -5.0% to -3.0% |
| `messaging/suspend` | unlimited | -3.4% | -4.2% to -1.0% |
| `lifecycle/load-small` | unlimited | -0.8% | -1.1% to -0.4% |
| `lifecycle/load-large` | unlimited | -3.0% | -9.7% to -1.4% |
| `probe/straightline` | unlimited | -6.6% | -12.5% to -5.1% |
| `probe/straightline` | 100 | -4.3% | -5.6% to -4.2% |
| `probe/protected-loop` | unlimited | -4.5% | -4.6% to -3.9% |
| `probe/protected-loop` | 100 | -5.2% | -7.0% to -3.6% |

Loops, addition, straight-line moves and protected loops improve in every
pair. Tiny Fibonacci slices show little change because scheduling remains.
The initial lambda median is 2.1% slower with mixed pair signs. The separate
[five-pair recheck](2026-10-15-zig-scratch-recheck.json), with eleven samples
per process and alternating order, measures lambdas -4.2% (range -9.8% to
-0.3%), unsliced calls -6.5% (-14.2% to -1.1%) and sliced calls -6.5%
(-10.7% to -5.0%). The lambda regression does not reproduce. Smaller effects
on broader workloads remain noisy; this is evidence for retaining the narrow
scratch fast path, not for changing dispatch or scheduling.

## CPU and native safe assembly

Separate two-second, 1 ms CPU captures count only stacks beneath `talk_pump`.
The [compressed reports and disassembly](2026-10-15-zig-scratch-profiles/)
retain symbols, addresses and offsets. Inclusive categories overlap, and
inlining limits attribution; sampled percentages are not projected speedups.

| Workload | Slice | Pump samples before / after | Scratch reset before / after | Charging before / after |
| --- | ---: | ---: | ---: | ---: |
| `core/loop` | unlimited | 1547 / 1546 | 6.6% / 0.0% | 11.5% / 11.6% |
| `core/loop` | 100 | 1446 / 1474 | 4.4% / 0.0% | 7.7% / 7.7% |
| `core/calls` | unlimited | 1540 / 1544 | 6.6% / 0.5% | 8.7% / 9.2% |
| `core/calls` | 100 | 1428 / 1445 | 3.0% / 0.6% | 6.7% / 5.3% |
| `numbers/add` | unlimited | 1549 / 1553 | 7.4% / 0.0% | 9.6% / 10.8% |
| `probe/straightline` | unlimited | 1491 / 1476 | 7.9% / 0.0% | 11.7% / 9.9% |
| `probe/straightline` | 100 | 1432 / 1434 | 5.8% / 0.2% | 8.5% / 6.8% |
| `probe/protected-loop` | unlimited | 1545 / 1548 | 6.7% / 0.0% | 9.1% / 10.0% |
| `probe/protected-loop` | 100 | 1457 / 1449 | 4.0% / 0.1% | 4.5% / 5.5% |

The before assembly calls `ArenaAllocator.reset` unconditionally at loop
entry and on the backedge (`Group.execute+0x5c` and `+0xa8`). The after
assembly checks the free list at `+0xc8`; with none, `+0x200` checks the used
head, its end index and next pointer. An empty state jumps directly to clause
accounting at `+0xd8`; dirty state still calls the unchanged standard reset
at `+0xd4`. The predicate is inlined, so zero named reset samples still leave
the predicate's loads and branches in `execute`. Bounds and overflow traps
remain in both `safe` binaries. This audit supports the targeted reset change,
not an attribution of the rest of the execution loop to removable overhead.

## Limited four-way refresh

`bun run bench --only zig,ts,applescript,gopher-lua --count 3` completes with
111 measurements: 30 native Zig, 39 TS, 21 AppleScript and 21 GopherLua.
Every output is correct and overlapping Zig/TS Fuel agrees. The
[full report](2026-10-15-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua-scratch-reset.md)
and [raw data](2026-10-15-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua-scratch-reset.json)
record sample extrema, versions and skipped workloads. Zig and peers use
three repeats; mitata chooses TS sample counts. This refresh uses the same
compiled Core library as the paired after Host. Binary/assembly provenance
is recorded in the [artifact manifest](2026-10-15-zig-scratch-artifacts.json).

These are **Run** medians in milliseconds, excluding Load:

| Workload | Zig | TS | AppleScript | GopherLua |
| --- | ---: | ---: | ---: | ---: |
| `core/loop` | 0.8178 | 2.8111 | 0.2028 | 0.0295 |
| `core/calls` | 0.6201 | 1.9937 | 0.6816 | 0.0821 |
| `core/fib` | 0.5758 | 2.3020 | 0.5341 | 0.0803 |
| `core/lambdas` | 0.7816 | 2.9460 | 0.7511 | 0.0965 |
| `numbers/add` | 0.4128 | 1.7116 | 0.2542 | 0.0307 |
| `numbers/quantity` | 0.2836 | 1.3274 | 0.1254 | 0.0132 |
| `text/build` | 0.6454 | 0.7520 | 0.3843 | 0.0825 |
| `collections/list-append` | 0.8659 | 4.9300 | 1.5339 | 0.2022 |
| `macro/report` | 1.2302 | 1.5853 | 3.6003 | 0.1314 |

Separately, **Load** medians in microseconds:

| Workload | Zig | TS |
| --- | ---: | ---: |
| `core/loop` | 6.79 | 114.56 |
| `core/calls` | 8.13 | 138.00 |
| `core/fib` | 7.24 | 137.58 |
| `core/lambdas` | 9.59 | 170.17 |
| `numbers/add` | 6.85 | 138.33 |
| `numbers/quantity` | 18.92 | 128.67 |
| `text/build` | 6.20 | 80.54 |
| `collections/list-append` | 10.42 | 192.62 |
| `macro/report` | 8.03 | 114.67 |

The peer runners do not report a separate Load metric here. Zig's remaining
loop gap against AppleScript is about 4.03×, but AppleScript uses its native
counted loop while NorthTalk explicitly compares and increments. That gap
cannot all be attributed to dispatch. This cross-runtime refresh is context;
changes from earlier reports on the shared host are not paired optimization
gains. The alternating same-base experiment above supplies that evidence.

## Accounting and conformance

All 108 full-suite pairs and 15 recheck pairs reproduce the same output,
Fuel and logical allocation in timed and untimed Runs. Separate allocator
probes also match allocation requests, cumulative bytes, frees, peak/live
memory, retained Group memory and the size histogram on both binaries.
The counting allocator uses `posix_memalign`; its probes diagnose physical
requests separately from default-allocator timings. Requests cover one Run
after Load; Group peak includes Load.

Unsliced and sliced loops remain 48,016 Fuel / 64,000 logical bytes; calls
46,018 / 32,072; addition 26,030 / 32,104. Straight-line moves remain
521 / 0 and the protected loop 22,021 / 32,072 at both slices. The protected
probe iterates inside `try/finally`, retaining its operand-protection path.

- `zig build test --summary all`: 244/244 native tests and the C Host tests
  pass, including the three scratch tests, physical allocation refusal and
  cleanup after refusal, charging, metering and lifecycle tests.
- `zig build corpus`: all 429 cases pass, including ordinary and
  between-Pump Save/Restore Trace replay, Recovery Offers, failed cleanup,
  landed cancellation/Stop/Rewind, limit fault positions and protected state.
- `zig build corpus -- --defer-crossings`: all 429 cases pass with eligible
  Host crossings deferred once, including the same Save/Restore replays.
- Unicode preparation, generated tables and Spec checks, lint, format,
  Zig formatting and the C API catalogue check pass.

No Spec, Cost Model or blessed expectation bytes change. No first-blessing
approval is required. Performance measurements beyond native Zig, TS,
AppleScript and GopherLua are outside this experiment.

## Reproduction

Build the baseline at `0aed90d3` with `zig build` in `impl/zig`, save its
library/Host, then build the changed checkout in the same mode. Compile both
Hosts with the same command and preserve each executable before relinking:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c /path/to/libtalk.a -o /path/to/host
python3 bench/zig/instruction-bookkeeping.py /path/to/before /path/to/after \
  --before-revision 0aed90d3 --source-file impl/zig/src/machine/scratch.zig \
  --pairs 3 --count 7 --profiles /path/to/profiles \
  --profile-filter core/loop --profile-filter core/calls \
  --profile-filter numbers/add --profile-filter probe/ \
  --out /path/to/results.json
python3 bench/zig/instruction-bookkeeping.py /path/to/before /path/to/after \
  --before-revision 0aed90d3 --source-file impl/zig/src/machine/scratch.zig \
  --filter core/lambdas --filter core/calls --pairs 5 --count 11 \
  --out /path/to/recheck.json
xcrun llvm-objdump --disassemble --demangle /path/to/host
bun run bench --only zig,ts,applescript,gopher-lua --count 3
```

The saved assembly extracts contain `Group.execute` and
`ArenaAllocator.reset`. The historical same-day four-way reports are retained;
this experiment's refresh is saved separately with a `scratch-reset` suffix.
