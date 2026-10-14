# Zig division and Unit conversion measurements, 2026-10-14

Evidence for [#923](https://github.com/odogono/odgn-talk/issues/923), comparing
baseline `f385603fd2e3bb34856c578cf3d0c13254fcc809` with this working tree.
The [raw measurements](2026-10-14-zig-division-paths.json) retain pre-edit
intake timings and allocation probes, three paired runs over all 30 supported
manifest workloads and four extra probes, samples, accounting and binary/source
hashes. The repeating-division probe was measured separately after the main
pairs; both binary hashes match.

Division improves from 0.946 to 0.449 ms (2.11×), Quantity arithmetic from
1.264 to 0.469 ms (2.69×), and text indexing from 1.536 to 1.036 ms (1.48×).
The integer `div` and `mod` probes improve by 2.34× and 2.01× respectively.
Every timing and separate allocation probe preserves output, Fuel and logical
allocation. No Spec, catalogue, blessed record or Cost Model changes.

## Method and baseline

Apple M5, macOS 27.0.1, arm64; Zig 0.17.0 native `safe`, Apple clang 21.0.0
Host at `-O2`, language 1.0-rc.3 and Cost Model 0. Each process validates output
and accounting outside timing, then records five samples, each averaging
complete Runs over at least 50 ms. Tables use the median of three process
medians. Process order alternates between pairs; allocation probes run
separately with the counting allocator. Load is outside the Run timer.
No other builds, tests or profiles from this thread ran during these pairs;
other work was active on the machine, so these are advisory measurements.

Before implementation edits, local baseline processes measured division at
0.934–0.938 ms, Quantity at 1.237–1.250 ms, `div` at 0.962–0.963 ms, and `mod`
at 0.897–0.907 ms. The pre-edit raw record also retains text indexing,
addition/multiplication and the plain-factor Quantity reference (then at
1,000 iterations; paired reference runs below use 500 to match Quantity).
Initial custom probe checksum typos were corrected against integer sums
before any implementation edits; only validated successful probes are retained.

## Paired timings

Run medians in milliseconds. `probe/div` sums `i div 8`, `probe/mod` sums
`i mod 16`, and `probe/divide-repeating` sums `i / 3`, for 1,000 iterations.
The plain-factor reference sums `(i * 1000 * 0.001) / 1` for 500 iterations.

| Workload | Before ms | After ms | Speedup |
| --- | ---: | ---: | ---: |
| `core/loop` | 1.313 | 1.316 | 1.00× |
| `core/fib` | 0.936 | 0.945 | 0.99× |
| `core/fib@slice=10` | 4.997 | 5.491 | 0.91× |
| `core/fib@slice=100` | 1.363 | 1.362 | 1.00× |
| `core/fib@slice=1000` | 0.988 | 0.990 | 1.00× |
| `core/fib@slice=10000` | 0.946 | 0.945 | 1.00× |
| `core/calls` | 0.898 | 0.899 | 1.00× |
| `core/lambdas` | 1.205 | 1.212 | 0.99× |
| `numbers/add` | 0.667 | 0.675 | 0.99× |
| `numbers/multiply` | 0.430 | 0.431 | 1.00× |
| `numbers/divide` | 0.946 | 0.449 | 2.11× |
| `numbers/quantity` | 1.264 | 0.469 | 2.69× |
| `text/build` | 0.495 | 0.468 | 1.06× |
| `text/iterate` | 0.727 | 0.726 | 1.00× |
| `text/index` | 1.536 | 1.036 | 1.48× |
| `text/patterns` | 0.628 | 0.633 | 0.99× |
| `text/graphemes` | 1.341 | 1.346 | 1.00× |
| `collections/list-build` | 0.801 | 0.805 | 1.00× |
| `collections/list-append` | 1.371 | 1.367 | 1.00× |
| `collections/map-build` | 0.958 | 0.964 | 0.99× |
| `collections/list-update` | 0.810 | 0.808 | 1.00× |
| `collections/map-update` | 0.282 | 0.281 | 1.00× |
| `collections/iterate` | 2.123 | 2.127 | 1.00× |
| `host/pump` | 0.002 | 0.002 | 1.01× |
| `macro/transform` | 0.683 | 0.684 | 1.00× |
| `macro/report` | 1.234 | 1.227 | 1.01× |
| `macro/game-tick` | 1.697 | 1.711 | 0.99× |
| `messaging/suspend` | 3.129 | 3.207 | 0.98× |
| `lifecycle/load-small` | 0.002 | 0.002 | 0.92× |
| `lifecycle/load-large` | 0.178 | 0.175 | 1.01× |
| `probe/div` | 1.003 | 0.429 | 2.34× |
| `probe/mod` | 0.924 | 0.460 | 2.01× |
| `probe/quantity-factors` | 0.591 | 0.322 | 1.84× |
| `probe/divide-repeating` | 1.724 | 1.721 | 1.00× |

The repeating-division probe remains effectively unchanged (1.724 versus
1.721 ms), covering the cost of attempting an exact path before falling back.
Other workload medians move by about 0–2%, except tiny Load (8.6% at roughly
2 microseconds), the smallest Fibonacci Fuel Slice (4.997 to 5.491 ms, 9.9%) and suspension (3.129 to 3.207 ms, 2.5%).
Fibonacci's individual before/after process medians overlap (before
4.977–5.437 ms; after 4.894–5.557 ms); its second and third pairs are slower.
No claim of a suspension or small-slice speedup is made. Isolated slow samples
also appear in lambdas, Map construction and game-tick; the raw record keeps
these rather than selecting faster samples. These workloads do not use the
new division/Unit paths, so their movement is a limitation of the machine-level
comparison, not evidence for a causal improvement or regression.

A [targeted three-pair recheck](2026-10-14-zig-division-regression-check.json)
repeats Fibonacci and suspension after all peer measurements and CPU profiling,
using the same binary hashes and settings. The smallest Fuel Slice medians
are 5.034 versus 5.039 ms (0.1%), and suspension is 3.149 versus 3.168 ms
(0.6%). Two of three small-slice pairs favor the optimized binary, unlike the
first comparison. The original slowdown does not reproduce; the report retains
both sets of measurements as evidence of timing variation.

## Allocation and first-class Quantity work

Untimed single-Run probes use `NORTHTALK_BENCH_ALLOCATIONS=1`. Host allocation
requests cover Group Delivery/Pump, excluding Load and process-owned values;
bytes are cumulative requests, not live or resident memory. The counting
allocator's resizing behavior differs from the default timing allocator.

| Workload | Calls before | After | Bytes before | After | Fuel | Logical bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `numbers/divide` | 23,062 | 28 | 651,104 | 12,788 | 18,031 | 32,104 |
| `numbers/quantity` | 23,032 | 30 | 654,962 | 13,532 | 14,579 | 40,088 |
| `probe/div` | 25,600 | 28 | 748,701 | 12,787 | 18,025 | 32,088 |
| `probe/mod` | 22,524 | 28 | 682,047 | 12,786 | 18,025 | 32,088 |
| `text/index` | 23,526 | 1,030 | 685,838 | 16,577 | 26,640 | 51,072 |
| `probe/quantity-factors` | 11,529 | 29 | 333,399 | 13,156 | 14,079 | 32,088 |

Exact division and Quantity calls fall by more than 99.8%, and their requested
bytes by about 98%. These are scratch-storage savings; immutable result Values
still allocate, and the existing Group node cache serves most physical Value
requests. Physical caps and logical charging are unchanged.

At the same 500-iteration size and checksum, first-class Quantity work takes
0.469 ms versus 0.322 ms for the plain-factor reference, about 46% more.
It requests 30 allocations/13,532 bytes versus 29/13,156 for that reference.
The extra time includes Unit checks, additional specified conversion steps
and Quantity Value handling; this is a controlled workload contrast, not a
measurement of Unit metadata alone. AppleScript's Quantity port uses plain
numeric factors, so its remaining gap includes this extra language behavior.

## Separate CPU samples

[Four Pump profiles](2026-10-14-zig-division-profiles.json) retain hashed,
compressed call trees and binary hashes. Each uses macOS `sample` for two
seconds at 1 ms intervals, separate from all timing/probe runs. Launch the
same Host with count 2,000, sample after 0.1 seconds, then terminate it after
sampling; that keeps the sampling window within repeated validated Runs
rather than the later Load phase. Attribution below uses only stacks under
`talk_pump`, subtracting child counts before aggregating leaf samples.
Categories are inclusive and overlap; inlining limits named attribution.

Decimal work falls from 820/1,496 division Pump samples (54.8%) to 117/1,494
(7.8%). In Quantity it falls from 935/1,475 (63.4%) to 83/1,511 (5.5%).
The overlapping Unit category falls from 738/1,475 (50.0%) to 317/1,511
(21.0%), corroborating the remaining first-class Unit work. Allocator stacks
fall from 19.2% to 7.7% in division and 16.8% to 5.8% in Quantity. Dispatch,
Value handling and charging remain; these profiles support attribution, not
an independent speedup measurement.

## Residual peer gaps

The separate [fresh numeric four-runner comparison](2026-10-14-zig-division-peers.md)
uses only native Zig, the TS Core, AppleScript and GopherLua. It checks Core
Fuel parity, uses three Zig/peer repeats and mitata's automatic TS sampling.
This later run measures Zig division at 0.499 ms versus AppleScript's 0.206 ms
(2.42× gap), and Quantity at 0.508 versus 0.126 ms (4.03× gap). The original
issue's 5.01× and 10.66× gaps shrink materially, while differences in numeric
types, idiomatic ports and first-class Unit semantics remain. Its timings are
separate from the paired native medians, so they are not mixed into a speedup.
WASM and other Peer Language performance runners were not used.

## Exact-path scope and equivalence

Terminating division uses bounded decimal long division with `u128`
coefficients/remainders and at most 68 expansion steps. It returns only an exact
result fitting the Decimal precision/exponent limits, preserves quantum nearest
the ideal, and expands a positive exponent to zero for bounded Script numbers.
`div`/`mod` use checked exponent alignment followed by unsigned quotient/remainder
and the specified sign rules. Zero never gains a negative sign. Repeating
fractions, rounding, subnormals requiring rounding, overflow and wider
intermediates use the unchanged managed rational implementation.

Unit factors are parsed from the generated catalogue at compile time. Every
Kind factor and both temperature ratio factors remain separate arithmetic
steps, in the original numerator/denominator phases and Kind order. Factor one
and powers of ten benefit from the Decimal paths; no conversion factors are
collapsed or reordered, including Compound Units and repeated source slots.

The private general arithmetic oracle checks at least 12,960 representative
and seeded comparisons across all six operators, signs, zeros, exponents,
34-digit/overflow boundaries, half-even ties, subnormals and bounded/unbounded
Base Unit comparisons. Every successful exact case is rerun with an allocator
that refuses its first request. Focused tests cover terminating fractions,
division by zero and fallback allocation cleanup. The managed-integer path can
vary allocation counts between runs; its refusal sweep verifies balanced
allocated/freed bytes and either the exact expected result or OutOfMemory,
including successful recovery after an optional request is refused.

Unit tests check full Decimal fields against explicit ordered factor sequences
for identity, powers of ten, volume, temperature ratios and Compound Units,
including zero, quantum, overflow and subnormal rounding. Unit fallback tests
exercise every allocation refusal. Value arithmetic tests require exactly one
immutable result allocation for successful exact operators; refusing it leaves
both operands intact.

## Validation and reproduction

- Native `zig build test --summary all`: 218/218 tests and the C Host tests pass.
- `zig build corpus` and `zig build corpus -- --defer-crossings`: all 429 cases
  pass, including ordinary/restored Trace replay, sessions, resource limits,
  rollback, numeric and Quantity cases, without expectation changes.
- Safe wasm32-wasi reactor and `uv run tools/wasi/zig.py`: pass, including
  physical containment and healthy fresh Groups after refusal.
- The Decimal/Unit test root compiled with `zig test -Osafe -target wasm32-wasi
  --test-no-exec` and ran in Wasmtime 49.0.0: all 15 tests pass, including the
  oracle comparisons and allocation refusal on wasm32.
- TS/Zig fuzz witnesses and mutations, repository Spec/docs checks, Unicode,
  generated Zig/API checks, Zig formatting, lint and formatting checks pass.
- The fresh numeric four-runner comparison validates output and Core Fuel parity.

Build each revision in `impl/zig` with `zig build`, then link the same Host:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c impl/zig/zig-out/lib/libtalk.a -o /path/to/host
python3 bench/zig/division-paths.py /path/to/before /path/to/after \
  --before-revision f385603fd2e3bb34856c578cf3d0c13254fcc809 \
  --pairs 3 --count 5 --out /path/to/results.json
bun run bench --only zig,ts,applescript,gopher-lua --filter numbers --count 3 --no-save
```

For wasm32 numeric tests, a temporary root in `impl/zig/src` imports
`decimal/decimal.zig` and `units.zig`. Wasmtime's WASI configuration supplies a
nonempty argv and inherited stdout/stderr; an exit status of zero is success.
