# Zig scalar constructor measurements — 2026-10-14

Evidence for [#937](https://github.com/odogono/odgn-talk/issues/937).

**Retain the narrow constructors.** The strongest evidence is removal of
unnecessary memory traffic and repeated modest scalar-heavy gains, with no
extra allocation or layout change. Calls improve in all three longer pairs
(1.02–1.05×) and eight of nine short pairs (median 1.04×); addition improves in
all three longer pairs (1.01–1.03×) and eight of nine short pairs. This does not
establish a uniform speedup: Quantity and very small Fuel Slice effects are
weaker, and the shared machine makes small timing differences uncertain.

The experiment retains the existing Value and Data layout, inline Quantity,
per-Group node cache, allocator ownership, reference counting and ranks. It
specializes Nothing, Boolean and Number construction at the existing scalar
entry point. Small tags remain visible at callers; the other kinds keep the
existing constructor and ownership-rank calculation.

The narrow allocator requests precisely `@sizeOf(Value)` with `@alignOf(Value)`
from the same allocator vtable as `Allocator.create`. It then assigns a typed
Value literal, including every defaulted header and the active tagged payload,
before returning the node. It avoids `create`'s explicit undefined-memory fill.
There is no change to runtime-safety mode, allocator admission, the physical
cap, logical charging, lowering, instruction/source positions or restore format.

Assembly shows Number and Boolean no longer write a full 368-byte poison fill
or copy the 304-byte Data union. Zig still zero-fills Nothing's union, so the
hypothesis that every small constructor can write only its active payload is
only partly borne out. Avoiding that fill with assumptions about the union's
private tag offset is outside this experiment. The fallback still poisons and
copies its union; Quantity remains inline and gets no second allocation.

## Reproduction and measurement boundary

Apple M5 (10 cores, 24 GiB), macOS 27.0.1 arm64, Zig 0.17.0 `safe`, Apple clang
21 with C Host `-O2`, language 1.0-rc.3 and Cost Model 0. The baseline was
`main` at `f51ad856`. The measured after is the scalar-constructor working tree
committed as `797d1c63`; source and binary hashes identify it in each JSON.
No #935/#936 change is included in these timings. Later integration with #935
does not change the recorded measurement baseline or imply a new speedup claim.

Before editing, the [baseline self-comparison](2026-10-14-zig-scalar-baseline.json)
recorded three samples per process for loops, calls, addition, Quantities and
sliced loops/calls. Unsliced before/second-process medians were 1.038/1.044 ms
for loop, 0.703/0.705 ms for calls, 0.516/0.519 ms for addition and 0.425/0.404 ms
for Quantities. The baseline assembly independently reproduces the reported
poison/copy sites. This control already shows why a small effect needs pairs.

Build each native library with `cd impl/zig && zig build`, then link its own
Host from the repository root:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c impl/zig/zig-out/lib/libtalk.a -o /path/to/host
python3 bench/zig/instruction-bookkeeping.py /path/to/before /path/to/after \
  --before-revision f51ad856 --pairs 3 --count 10 --out /path/to/paired.json
python3 bench/zig/instruction-bookkeeping.py /path/to/before /path/to/after \
  --before-revision f51ad856 --pairs 9 --count 1 --out /path/to/recheck.json
```

The [longer pairs](2026-10-14-zig-scalar-constructors.json) include every
supported manifest workload, Fibonacci's Fuel Slice sweep, sliced loops/calls,
straight-line moves and a protected loop: 36 variants, 108 comparisons.
The [shorter pairs](2026-10-14-zig-scalar-recheck.json) repeat all 36 variants
nine times, with one sample per process, giving 324 comparisons. Each sample
averages checked Runs over at least 50 ms. Load samples precede Run samples;
Load is outside Run timing. Binary order alternates between rounds. Every
process repeats Runs against the same loaded Script. The nine unsupported
benchmark Host bindings remain outside timings, not outside conformance.

An initial five-sample wave was stopped and excluded after it overlapped a
large burst of unrelated compilation. Compilation recurred on the shared
machine during later measurements too; absolute Run times drift appreciably.
The short-pair recheck reduces the time between paired processes and tests
whether the direction persists; it is not an isolated-machine confidence
interval. Do not turn these observations into a promised percentage.

## Generated safe-mode assembly

The [native assembly](2026-10-14-zig-scalar-disassembly.txt) records the commands,
binary hashes, original `value.scalar`, retained `scalarOwned` fallback and
actual C constructors for all three tags. In the original scalar, `movi.16b
v0, #0xaa` feeds 368 bytes of stores; `w2 = 0x130` feeds `_memcpy` for 304 bytes.
After specialization, `talk_bool` writes its Boolean, tag and header directly;
`talk_int` writes its Decimal fields, tag and header. Neither contains the fill
or union copy. Both still check allocation refusal and alignment. Nothing
removes the poison and copy but keeps a compiler-generated 304-byte zero fill.

`Value` remains 368 bytes and `Data` 304 bytes on this target. The native Host's
`__text` grows from 2,087,248 to 2,090,180 bytes (2,932 bytes, 0.14%); inlining
is not free. There is no `@setRuntimeSafety(false)`, fast build or private union
layout manipulation. The typed literal supplies references=1, the owning
allocator, zero measure/rank, false error/Script flags, null List storage and
release link, plus the active tag and complete Decimal/Boolean payload.

## Paired Run timings

Run times below are medians of per-process medians, in milliseconds. The three
speedups divide adjacent before/after times; the last column gives the median
of the nine shorter pair ratios and how many improve. These ratios need not
equal the ratio of independently aggregated time medians when the machine's
speed changes. Both JSON files also retain every Load sample.

| Workload | Before ms | After ms | Longer pair speedups | Short-pair median (wins/9) |
| --- | ---: | ---: | --- | ---: |
| `core/loop` | 1.0477 | 1.0187 | 1.02×, 1.19×, 1.04× | 1.05× (6/9) |
| `core/loop@slice=100` | 1.5600 | 1.5752 | 0.99×, 1.00×, 1.01× | 1.02× (8/9) |
| `core/fib` | 0.7481 | 0.7101 | 1.05×, 1.00×, 1.06× | 1.07× (8/9) |
| `core/fib@slice=10` | 5.1306 | 5.9097 | 0.87×, 1.10×, 1.00× | 1.02× (7/9) |
| `core/fib@slice=100` | 1.1993 | 1.2497 | 0.96×, 1.02×, 0.99× | 1.06× (9/9) |
| `core/fib@slice=1000` | 0.9303 | 0.8717 | 1.08×, 1.04×, 1.07× | 1.12× (8/9) |
| `core/fib@slice=10000` | 0.8837 | 0.8447 | 0.98×, 1.06×, 1.05× | 1.08× (9/9) |
| `core/calls` | 0.8428 | 0.8258 | 1.05×, 1.04×, 1.02× | 1.04× (8/9) |
| `core/calls@slice=100` | 1.3308 | 1.2982 | 1.04×, 1.01×, 1.03× | 1.02× (6/9) |
| `core/lambdas` | 1.1337 | 1.0761 | 1.06×, 1.02×, 1.05× | 1.04× (8/9) |
| `numbers/add` | 0.6216 | 0.6137 | 1.03×, 1.02×, 1.01× | 1.09× (8/9) |
| `numbers/multiply` | 0.4083 | 0.3839 | 1.05×, 1.03×, 1.06× | 1.08× (8/9) |
| `numbers/divide` | 0.4447 | 0.4304 | 1.05×, 1.04×, 1.03× | 1.07× (6/9) |
| `numbers/quantity` | 0.4862 | 0.4716 | 1.03×, 1.04×, 0.98× | 1.01× (7/9) |
| `text/build` | 0.5482 | 0.5153 | 1.08×, 1.04×, 1.06× | 1.01× (5/9) |
| `text/iterate` | 0.7244 | 0.7031 | 1.04×, 1.03×, 1.03× | 1.01× (5/9) |
| `text/index` | 0.8463 | 0.8083 | 1.04×, 1.08×, 1.04× | 1.04× (6/9) |
| `text/patterns` | 0.7306 | 0.7336 | 1.02×, 1.04×, 0.84× | 1.03× (8/9) |
| `text/graphemes` | 1.4256 | 1.3831 | 0.92×, 0.93×, 1.03× | 1.02× (7/9) |
| `collections/list-build` | 0.2924 | 0.2828 | 1.04×, 0.97×, 1.03× | 0.97× (2/9) |
| `collections/list-append` | 1.3736 | 1.3812 | 0.97×, 1.01×, 0.99× | 1.00× (5/9) |
| `collections/map-build` | 1.2564 | 1.2464 | 0.96×, 0.99×, 1.01× | 0.99× (4/9) |
| `collections/list-update` | 0.8001 | 0.8077 | 1.03×, 1.00×, 0.99× | 1.03× (5/9) |
| `collections/map-update` | 0.3005 | 0.2755 | 1.03×, 1.01×, 1.09× | 1.02× (7/9) |
| `collections/iterate` | 2.0952 | 1.9924 | 1.02×, 1.01×, 1.05× | 1.01× (6/9) |
| `host/pump` | 0.0019 | 0.0019 | 1.05×, 1.02×, 0.97× | 1.00× (6/9) |
| `macro/transform` | 0.3528 | 0.3322 | 1.00×, 1.02×, 1.06× | 1.02× (9/9) |
| `macro/report` | 1.2978 | 1.3416 | 1.06×, 1.03×, 0.97× | 0.98× (3/9) |
| `macro/game-tick` | 1.8499 | 1.5275 | 1.03×, 1.03×, 1.21× | 1.02× (6/9) |
| `messaging/suspend` | 3.5213 | 3.4844 | 1.05×, 1.01×, 1.07× | 1.01× (7/9) |
| `lifecycle/load-small` | 0.0021 | 0.0018 | 0.99×, 1.15×, 1.02× | 1.02× (7/9) |
| `lifecycle/load-large` | 0.1725 | 0.1911 | 0.99×, 1.01×, 0.90× | 1.02× (7/9) |
| `probe/straightline` | 0.0173 | 0.0165 | 1.11×, 0.99×, 1.00× | 0.99× (3/9) |
| `probe/straightline@slice=100` | 0.0204 | 0.0205 | 1.00×, 1.00×, 0.99× | 0.98× (3/9) |
| `probe/protected-loop` | 0.5597 | 0.6562 | 0.85×, 1.08×, 1.05× | 1.06× (7/9) |
| `probe/protected-loop@slice=100` | 0.9559 | 0.7710 | 1.24×, 1.01×, 1.33× | 1.06× (7/9) |

The shortest Fibonacci Slice has mixed longer pairs and a short-pair median
of 1.02×. Quantity construction keeps the old path; any gain comes from small
Values around it. Its longer pairs are mixed and its short-pair median is
only 1.01×. Neither supports a large speedup claim.

### Broader regression recheck

The short wave flagged List building, report formatting and straight-line
moves. A separate [five-pair recheck](2026-10-14-zig-scalar-regressions.json),
with five samples per process, checks those four variants rather than
silently discarding their slower measurements:

| Workload | Pair speedups | Median paired speedup |
| --- | --- | ---: |
| `collections/list-build` | 0.97×, 0.93×, 1.05×, 1.06×, 1.02× | 1.020× |
| `macro/report` | 0.98×, 1.10×, 1.04×, 1.05×, 0.98× | 1.043× |
| `probe/straightline` | 1.11×, 0.92×, 1.00×, 0.97×, 1.02× | 1.003× |
| `probe/straightline@slice=100` | 1.01×, 0.99×, 0.98×, 1.04×, 0.98× | 0.994× |

The List/report slowdowns do not persist in the longer recheck. Sliced
straight-line execution remains about 0.6% slower at the median, with mixed
pairs; unsliced execution is essentially unchanged. These data establish no
stable material regression, but leave sub-percent differences unresolved.
Retention is justified by the focused memory-traffic reduction and repeated
scalar-heavy gains, not by claiming every row is faster.

## Accounting, allocation and ownership

All **452** longer, shorter and regression comparisons preserve output, exact
Fuel and logical allocation, across timings and separate counting-allocator
probes. Every recorded physical-allocation field agrees too: cumulative
requested bytes, requests, frees, live peak delta, Group used/peak and the full
top-size list. This saves writes, not allocation requests or retained memory.

Representative fields below are identical before and after:

| Workload | Fuel | Logical bytes | Host requests | Requested bytes | Live peak delta | Group peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `core/loop` | 48016 | 64000 | 24 | 11877 | 10102 | 26784 |
| `core/calls` | 46018 | 32072 | 29 | 12805 | 10998 | 31676 |
| `numbers/add` | 26030 | 32104 | 26 | 12274 | 10470 | 25860 |
| `numbers/quantity` | 14579 | 40088 | 29 | 13388 | 11582 | 31288 |
| `core/loop@slice=100` | 48016 | 64000 | 1946 | 1915225 | 11261 | 26784 |
| `core/fib@slice=10` | 46365 | 47328 | 18631 | 18379653 | 22938 | 31370 |

Probes count one Delivery/Pump Run, excluding Load and process-owned Host
Values/returned bytes. Frees do not subtract from cumulative requests. Group
peak includes Load. This counting allocator uses `posix_memalign` and is not
the default allocator used for timings; none of these fields is resident memory.

New tests cover all small tags, signed 34-digit coefficients, nonzero exponents
and zero, every header, tag, exact payload and logical size, one owned
reference, retain/release and first-allocation refusal. A released List node with growth storage
is reused as each small tag, clearing container metadata and preserving
its Group allocator; its Host-allocated child remains correctly owned. A new
parent still has greater rank than the reused leaf. Existing exhaustive
allocation-failure, cap, cache, container/arithmetic and C Host tests exercise
the unchanged paths and allocator boundaries. Other tags still calculate ranks
before allocation, including overflow refusal.

## Four-runner comparison

The [fresh core comparison](2026-10-14-zig-scalar-peers.md) and its
[JSON](2026-10-14-zig-scalar-peers.json) run only native Zig, the NorthTalk TS
Core, AppleScript and GopherLua, with three repeats for Zig and peers and
mitata's automatic TS sampling. Overlapping Core Fuel agrees. It uses Bun
1.4.3, Go 1.27.2 and GopherLua 1.1.2; actual versions and working-tree source
hashes are recorded. The pre-existing comparison files are preserved.

Zig/AppleScript Run ratios are 5.44× for loop, 1.09× for calls, 1.40× for
Fibonacci and 1.48× for Lambdas. Zig remains faster than the TS Core and slower
than GopherLua in these four workloads. Peers use idiomatic ports and native
numbers. In particular the counted AppleScript loop differs from NorthTalk's
condition and additions. These ratios describe residual gaps on this shared
machine, not an instruction-equivalent comparison or a new paired speedup.

## Verification

- `bun install --frozen-lockfile` and `bun run unicode:check`: pinned Unicode
  18.0.0 data verified; generated tables match.
- `zig build test --summary all`: **230/230** Zig tests and native C Host tests
  pass, including Value, refusal, ranks, retained captures, physical caps and
  Host/Group ownership checks.
- `zig build corpus` and `zig build corpus -- --defer-crossings`: **429/429**
  cases each, including ordinary and between-Pump Save/Restore Trace replay,
  scheduling, accounting, source positions, rollback and logical limits.
- The safe `wasm32-wasi` Corpus Host passes **429/429** cases in Wasmtime. Its
  test-only 8 MiB stack and preopened repository use the unchanged Core sources;
  the build command is in the [bookkeeping report](2026-10-14-zig-instruction-bookkeeping.md#validation).
- The shipping `zig build -Dtarget=wasm32-wasi` reactor retains its normal
  1 MiB stack; `uv run tools/wasi/zig.py` and `uv run tools/wasi/check.py` pass,
  including physical refusal containment and the Message Layer.
- `bun run check`, `bun run lint`, `bun run format:check`, `bun run zig:check`,
  `bun tools/zig/api.ts`, `zig fmt --check impl/zig` and `git diff --check` pass. Blessed expectations, Spec Data Files, logical costs
  and public C declarations are unchanged.
