# Zig Decimal comparison measurements — 2026-10-15

Evidence for [#939](https://github.com/odogono/odgn-talk/issues/939).

Retain the exact comparison shortcuts. Three longer pairs and nine closer pairs
support modest loop/Fibonacci gains and a larger improvement when comparing
34-digit coefficients at the same exponent. These are whole checked Script Run
timings, including loop, iterator, Value and Host costs, not isolated Decimal
instruction timings. They do not explain the remaining AppleScript loop gap.

The change handles signs and zeros before formatting, compares equal-exponent
coefficients directly, and scales only the higher-exponent coefficient with the
existing checked `u128` helper when the exponent gap is at most 38. Overflow or
a wider gap uses the original padded-digit comparator. Its body is unchanged
and remains the differential test oracle. No comparison constructs a result
Decimal or Value, normalizes an operand, rounds, uses floating point or allocates
scratch storage. The signatures and Value comparison call sites are unchanged.

There is no uniform speedup claim. The short-pair sign probe is about 1.9% slower
at its median, scaling-overflow about 0.9% slower, and extreme gaps essentially
unchanged. The old sign shortcut already avoided formatting. The retained
fallback incurs the extra fast-path checks; sampling and code layout may also
contribute, but these measurements do not establish the cause of small changes.
Several broad workloads are around 1% slower and the very short Host Pump row
is about 2.8% slower in the longer pairs. The table retains all of them.

## Baseline and reproduction

Apple M5 (10 cores, 24 GiB), macOS 27.0.1 arm64, Zig 0.17.0 `safe`, Apple clang
21, C Host `-O2`, language 1.0-rc.3 and Cost Model 0. Baseline is current `main`
at `151f2b8efd00208cd0141ef9b2ddd2d8ff3099c4`, containing the required `f51ad856`
and later fixes. Charge specialization (#935), Unit metadata (#936) and scalar
constructors (#937) are already present on both sides. No charge-helper change
is included in this experiment. The recorded after is the #939 working tree;
source and binary SHA-256 values identify it without claiming a merged commit.

Before editing the Core, the [baseline control](2026-10-15-zig-comparison-baseline.json)
ran the same baseline binary as both sides: three samples per process across
15 loop/Fibonacci/comparison variants. Its [eight separate CPU captures](2026-10-15-zig-comparison-baseline-profiles/)
include two captures per workload of the same baseline binary. The first loop
capture attributes 50/1,528 Pump samples (3.27%) to `Decimal.order`, reproducing
the issue's narrow attribution on the current base.

The baseline loop self-comparison measured 0.9602/0.8942 ms in its two processes. Even that control varies, so small gains need repeated pairs.

Build a native library at each revision with `cd impl/zig && zig build`, and
link that revision's `bench/zig/host.c` as `bench/ts/src/measure-zig.ts` does:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c impl/zig/zig-out/lib/libtalk.a -o /path/to/host
python3 bench/zig/comparison-paths.py /path/to/before /path/to/after \
  --before-revision 151f2b8efd00208cd0141ef9b2ddd2d8ff3099c4 \
  --pairs 3 --count 5 --profiles /path/to/profiles --out /path/to/paired.json
python3 bench/zig/comparison-paths.py /path/to/before /path/to/after \
  --before-revision 151f2b8efd00208cd0141ef9b2ddd2d8ff3099c4 \
  --pairs 9 --count 1 --filter core/loop --filter core/fib --filter probe/ \
  --out /path/to/recheck.json
```

The [longer pairs](2026-10-15-zig-comparison-paths.json) cover all 30 supported
manifest variants (including the four Fibonacci Fuel Slices), plus nine
comparison probes: 117 paired comparisons. The [closer recheck](2026-10-15-zig-comparison-recheck.json)
covers 15 focused variants nine times: 135 paired comparisons. Each timing
sample averages repeated checked Runs over at least 50 ms. Load timing is
separate; each process repeats Runs against one loaded Script. Binary order
alternates between rounds. Every probe receives operands through function
parameters, avoiding constant folding; probe source hashes are recorded.

All our compilation and conformance work finished before timing. This remains
a shared desktop, with unrelated background activity and visible absolute-time
drift. These pairs are evidence of direction and scope, not an isolated-machine
confidence interval or a promised percentage. The nine unsupported benchmark
Host bindings remain outside native timings, not outside Corpus conformance.

## Paired Run timings

Times are medians of per-process medians, in milliseconds. Ratios are adjacent
before/after pairs; the last column gives the nine shorter pairs' median ratio
and the count above 1.0. The median of paired ratios need not equal the ratio
of independently aggregated time medians.

| Workload | Before ms | After ms | Three paired speedups | Short-pair median (wins/9) |
| --- | ---: | ---: | --- | ---: |
| `core/loop` | 0.8913 | 0.8755 | 1.017×, 1.042×, 1.087× | 1.032× (7/9) |
| `core/fib` | 0.6235 | 0.6013 | 1.035×, 1.032×, 1.055× | 1.048× (8/9) |
| `core/fib@slice=10` | 4.8035 | 4.8071 | 1.005×, 1.053×, 0.999× | 1.016× (7/9) |
| `core/fib@slice=100` | 1.0819 | 1.0297 | 1.051×, 1.049×, 1.042× | 1.042× (9/9) |
| `core/fib@slice=1000` | 0.6664 | 0.6463 | 1.031×, 1.050×, 1.061× | 1.043× (9/9) |
| `core/fib@slice=10000` | 0.6274 | 0.6073 | 1.033×, 1.035×, 1.034× | 1.044× (9/9) |
| `core/calls` | 0.6048 | 0.6019 | 1.005×, 0.992×, 1.002× | — |
| `core/lambdas` | 0.7810 | 0.7795 | 1.002×, 1.004×, 1.039× | — |
| `numbers/add` | 0.4329 | 0.4260 | 0.993×, 1.015×, 1.022× | — |
| `numbers/multiply` | 0.2732 | 0.2735 | 1.014×, 0.995×, 1.003× | — |
| `numbers/divide` | 0.3124 | 0.3106 | 1.023×, 1.000×, 1.006× | — |
| `numbers/quantity` | 0.2775 | 0.2753 | 1.528×, 1.005×, 1.003× | — |
| `text/build` | 0.4088 | 0.4123 | 1.029×, 0.992×, 0.991× | — |
| `text/iterate` | 0.5118 | 0.5110 | 0.989×, 1.006×, 1.002× | — |
| `text/index` | 0.5993 | 0.6059 | 0.985×, 0.993×, 0.999× | — |
| `text/patterns` | 0.6106 | 0.5490 | 0.918×, 1.114×, 0.999× | — |
| `text/graphemes` | 1.0128 | 1.0015 | 0.785×, 1.008×, 1.017× | — |
| `collections/list-build` | 0.1934 | 0.1941 | 0.551×, 1.002×, 0.988× | — |
| `collections/list-append` | 0.8581 | 0.8626 | 0.986×, 0.990×, 0.997× | — |
| `collections/map-build` | 0.9535 | 0.9011 | 0.903×, 1.001×, 1.058× | — |
| `collections/list-update` | 0.5159 | 0.5347 | 1.019×, 1.003×, 0.965× | — |
| `collections/map-update` | 0.2397 | 0.2136 | 1.150×, 1.168×, 0.966× | — |
| `collections/iterate` | 1.4445 | 1.4924 | 1.212×, 0.988×, 0.953× | — |
| `host/pump` | 0.0017 | 0.0017 | 1.081×, 0.886×, 0.972× | — |
| `macro/transform` | 0.2858 | 0.2855 | 1.054×, 0.982×, 0.986× | — |
| `macro/report` | 1.2668 | 1.2059 | 1.054×, 0.899×, 1.071× | — |
| `macro/game-tick` | 1.3069 | 1.2899 | 1.011×, 1.086×, 1.013× | — |
| `messaging/suspend` | 2.8596 | 2.9975 | 0.915×, 1.013×, 1.002× | — |
| `lifecycle/load-small` | 0.0017 | 0.0017 | 1.028×, 0.985×, 1.009× | — |
| `lifecycle/load-large` | 0.1493 | 0.1465 | 0.997×, 1.030×, 1.010× | — |
| `probe/equal-exponent` | 3.5380 | 3.3470 | 1.042×, 1.041×, 1.062× | 1.054× (8/9) |
| `probe/cohort` | 3.5351 | 3.4994 | 1.053×, 0.999×, 1.057× | 1.038× (7/9) |
| `probe/scaled` | 3.3883 | 3.2461 | 1.070×, 1.039×, 1.054× | 1.051× (9/9) |
| `probe/sign` | 3.2404 | 3.2072 | 0.991×, 1.024×, 1.005× | 0.981× (2/9) |
| `probe/zero` | 3.3540 | 3.2275 | 1.061×, 1.039×, 1.043× | 1.035× (9/9) |
| `probe/wide` | 5.1791 | 3.1819 | 1.628×, 1.628×, 1.579× | 1.636× (9/9) |
| `probe/scale-overflow` | 4.2365 | 4.2747 | 0.991×, 1.005×, 0.979× | 0.991× (2/9) |
| `probe/extreme-gap` | 3.3524 | 3.3119 | 1.014×, 1.010×, 1.001× | 0.997× (2/9) |
| `probe/quantity-comparison` | 3.6064 | 3.4947 | 1.033×, 1.032×, 1.006× | 1.037× (7/9) |

The equal-exponent probe compares 12,345 and 12,346; cohorts compare `1` and
`1.00`; scaled operands compare `123.45` and `124`; zero compares `0.000` and
`0.01`; wide compares adjacent 34-digit integers. Scaling-overflow compares a
34-digit integer against `0.000001`, forcing checked multiplication overflow;
extreme-gap compares `1` with coefficient 1 at exponent −6176. The Quantity
probe compares `1 mm` and `1 m`. The sign probe uses opposite signs, a case
already handled directly by the baseline. Each probe executes 10,000 explicit
comparisons, plus its common range/iterator work.

The short-pair loop median is 1.032× (7/9 improve), Fibonacci 1.048× (8/9),
equal exponents 1.054× (8/9), cohorts 1.038× (7/9), bounded scaling 1.051×
(9/9), zero 1.035× (9/9) and wide coefficients 1.636× (9/9). The shortest
Fibonacci Fuel Slice benefits less because Pump overhead dominates. Numeric
arithmetic and Quantity workload ratios remain small; this experiment does
not change their arithmetic or Unit conversion paths.

## Separate CPU captures

Two-second macOS `sample` captures at a 1 ms interval run after all longer-pair
timings. Counts use only self samples whose ancestor path includes `talk_pump`;
comparator counts are inclusive of either `order` or `orderGeneral`. Categories
overlap, and compiler inlining affects attribution. Formatting may be inlined
inside the comparator, so the raw `fmt` category alone is not its total cost.
The [raw profiles](2026-10-15-zig-comparison-profiles/) and JSON retain all counts.

| Workload | Before comparator/Pump samples | After comparator/Pump samples |
| --- | ---: | ---: |
| `core/loop` | 75/1536 (4.88%) | 7/1530 (0.46%) |
| `probe/equal-exponent` | 109/1535 (7.10%) | 9/1532 (0.59%) |
| `probe/cohort` | 74/1541 (4.80%) | 28/1532 (1.83%) |
| `probe/extreme-gap` | 68/1540 (4.42%) | 78/1536 (5.08%) |

The general extreme-gap path remains visible, while common comparisons spend
less time inside the comparator. Sample percentages identify residual work;
they are not guaranteed removable percentages or substitutes for paired timing.
Native `__text` grows from 2,086,676 to 2,087,600 bytes (924 bytes, 0.044%). A
separately rebuilt after Host has identical `__text` bytes to the measured Host.

## Exactness, accounting and conformance

The [check record](2026-10-15-zig-comparison-checks.json) includes native results,
the WASI module hash and platform harness output. Verification completed on the
same Decimal source hash recorded by both timing suites:

- 241/241 native Zig tests, plus the `talk.h` C Host tests.
- Differential comparison against the unchanged original comparator over every
  decimal digit boundary, both signs, zeros, equal/unequal exponents, cohorts,
  34-digit coefficients, exponent −6176, internal positive Base Unit exponents,
  gap 38/39 and checked scaling overflow. Tests also compare 20,000 seeded
  generated pairs, exercising both operand orders.
- All 429 Corpus cases, with ordinary and automatic between-Pump Save/Restore
  replay for Trace Cases. All 429 also pass with deferred lifecycle crossings.
- The safe `wasm32-wasi` build passes `uv run tools/wasi/zig.py` and
  `uv run tools/wasi/check.py` through the C API and Message Layer.
- Unicode/generated-table verification, `talk.h` API check and Zig formatting.

Every baseline, longer-pair and short-pair process checks output. Across both
changed-binary timing suites, all 252 comparisons have identical Fuel and
logical allocation in timed and counting-allocator Runs. Separate probes also
match Host bytes, allocation/free counts, Group used/peak memory, live peak
deltas and the reported allocation-size distributions. No new result Value or
scratch allocation is introduced. Runs repeatedly exercise the same loaded
Script, retaining immutable operands. No blessed expectation, Data File,
lowering, canonical code/source position, Cost Model, rollback or restore
format changes.

## Four-runner comparison

The [fresh four-runner report](2026-10-15-zig-comparison-peers.md) and
[JSON](2026-10-15-zig-comparison-peers.json) contain 111 measurements: 30 native
Zig, 39 TS Core, 21 AppleScript and 21 GopherLua. Output checks and overlapping
Core Fuel parity pass. Zig and peers use three repeats; TS uses automatic
sampling. Versions include Bun 1.4.3, Go 1.27.2 and GopherLua 1.1.2.

```sh
bun run bench --only zig,ts,applescript,gopher-lua --count 3
```

Only these four runners were selected. Go hosts GopherLua; neither the Go Core,
other Peer Languages, Elixir nor WASI embedding timing is included. Results
were copied to issue-specific filenames, preserving the existing day's report.
The peer suite's independently rebuilt Zig Host has the same native `__text`
as the Host used for the paired measurements.

| Workload | Zig ms | TS Core ms | AppleScript ms | GopherLua ms | Zig / AppleScript |
| --- | ---: | ---: | ---: | ---: | ---: |
| `core/loop` | 0.9820 | 2.8931 | 0.1993 | 0.0322 | 4.93× |
| `core/fib` | 0.7156 | 2.5084 | 0.5268 | 0.0797 | 1.36× |
| `numbers/quantity` | 0.3110 | 4.3015 | 0.1236 | 0.0127 | 2.52× |

Peers use idiomatic ports and native numeric types; AppleScript's native
counted loop differs from NorthTalk's explicit while-loop condition and
increment. These are absolute after-change results, measured later under
shared desktop activity, not paired evidence for this optimization. The
current 4.93× AppleScript loop gap cannot be compared causally with the issue's
older 5.66× figure: this baseline contains intervening changes, and run
conditions differ. The 3–5% focused loop/Fibonacci gains leave most of that
gap unexplained.
