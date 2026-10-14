# Zig Decimal arithmetic measurements 2026 10 14

Evidence for [#877](https://github.com/odogono/odgn-talk/issues/877), comparing
baseline `05b24173285e4ed19271c5f7fa72ab87a109427d` with this issue's working-tree
optimization. This base includes #875 and the subsequently merged Map work
from #876. The [raw measurements](2026-10-14-zig-decimal-paths.json) retain the
intake baseline, three before/after pairs across all 30 supported workloads,
every timing sample, separate allocation probes, source and binary hashes,
and toolchain settings.

On Apple M5, macOS 27.0.1, arm64, Zig 0.17.0 in `safe` mode and Apple clang
21.0.0 at `-O2`, fractional addition improves from 1.831 to 0.763 ms (2.40×),
multiplication from 1.599 to 0.530 ms (3.02×), and the loop from 3.774 to
1.553 ms (2.43×). Quantity arithmetic improves from 2.923 to 1.408 ms (2.08×).
Every before/after measurement preserves output, Fuel and logical allocation
under language 1.0-rc.3 and Cost Model 0.

## Method and timing spread

The baseline was built and measured before editing Decimal arithmetic. Its
five-sample intake medians were 1.747 ms for addition, 1.518 ms for
multiplication, 1.561 ms for division, 2.734 ms for Quantity conversion and
3.509 ms for the loop. These establish the local baseline rather than assuming
the earlier #875 timings still apply.

The tables below report the median of three per-process medians. Each process
uses five samples, each averaging complete Runs over at least 50 ms, after
an untimed output/accounting validation. For each workload, a baseline process
immediately precedes the optimized process, followed by separate untimed
allocation probes. Load and compilation are outside the Run timer.

No other builds, tests or profiles from this thread ran during the recorded
pairs. Other work was active on the machine, so these are advisory paired
measurements, not isolated-machine timing claims. The first pair was slower
on both binaries. Addition's baseline medians span 1.824–1.933 ms and optimized
medians 0.737–0.792 ms; multiplication spans 1.543–1.683 and 0.495–0.534 ms.
The loop spans 3.525–4.758 and 1.536–1.893 ms. All three pairs improve for
addition, multiplication, loop and Quantity arithmetic.

## Arithmetic and broader workloads

Run medians, in milliseconds. Division itself retains the general path;
its benchmark also adds results and increments the loop index, which benefit
from the exact paths. The same explains improvements in nonnumeric workloads
that do arithmetic internally. Load medians are retained in the raw JSON;
the large-Load workload is effectively unchanged at 0.785 versus 0.791 ms.

| Workload | Before ms | After ms | Speedup |
| --- | ---: | ---: | ---: |
| `core/loop` | 3.774 | 1.553 | 2.43× |
| `core/fib` | 2.350 | 1.044 | 2.25× |
| `core/fib@slice=10` | 6.462 | 5.133 | 1.26× |
| `core/fib@slice=100` | 2.610 | 1.451 | 1.80× |
| `core/fib@slice=1000` | 2.306 | 1.060 | 2.17× |
| `core/fib@slice=10000` | 2.224 | 1.262 | 1.76× |
| `core/calls` | 2.046 | 1.070 | 1.91× |
| `core/lambdas` | 3.807 | 1.476 | 2.58× |
| `numbers/add` | 1.831 | 0.763 | 2.40× |
| `numbers/multiply` | 1.599 | 0.530 | 3.02× |
| `numbers/divide` | 1.682 | 1.100 | 1.53× |
| `numbers/quantity` | 2.923 | 1.408 | 2.08× |
| `text/build` | 0.536 | 0.526 | 1.02× |
| `text/iterate` | 1.775 | 0.884 | 2.01× |
| `text/index` | 2.277 | 1.755 | 1.30× |
| `text/patterns` | 0.926 | 0.756 | 1.22× |
| `text/graphemes` | 2.807 | 1.564 | 1.79× |
| `collections/list-build` | 1.255 | 0.956 | 1.31× |
| `collections/list-append` | 2.780 | 1.648 | 1.69× |
| `collections/map-build` | 1.133 | 0.996 | 1.14× |
| `collections/list-update` | 0.952 | 0.971 | 0.98× |
| `collections/map-update` | 0.319 | 0.320 | 1.00× |
| `collections/iterate` | 5.882 | 2.538 | 2.32× |
| `host/pump` | 0.002 | 0.002 | 1.00× |
| `macro/transform` | 1.290 | 1.016 | 1.27× |
| `macro/report` | 1.392 | 1.281 | 1.09× |
| `macro/game-tick` | 3.146 | 2.018 | 1.56× |
| `messaging/suspend` | 7.951 | 3.292 | 2.41× |
| `lifecycle/load-small` | 0.002 | 0.002 | 1.02× |
| `lifecycle/load-large` | 0.312 | 0.200 | 1.56× |

There is no material broader regression in these pairs. List update's median
is about 2% slower, with baseline medians 0.948–0.957 ms and optimized medians
0.944–0.976 ms. Map update, text construction and empty Pump are effectively
unchanged. The nine unsupported default-suite workloads remain outside this
comparison; their benchmark Host limitations are described in the
[suite guide](../README.md#native-zig-comparison).

## Allocation probes and profiling

Each probe is an untimed single Run with `NORTHTALK_BENCH_ALLOCATIONS=1`.
`hostBytes` and `hostAllocs` count cumulative Group allocation requests during
Delivery/Pump, excluding Load and process-owned Host values/returned bytes;
frees do not subtract. The counting allocator uses `posix_memalign` and has
different resizing behavior from the default Zig allocator. These are request
counts, not resident memory. Group peak includes Load. All three pairs
reproduce the same allocation figures.

| Workload | Requested bytes before | After | Allocation calls before | After | Fuel | Logical allocation bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `numbers/add` | 2,765,579 | 1,484,914 | 50,057 | 4,029 | 26,030 | 32,104 |
| `numbers/multiply` | 2,408,496 | 1,116,917 | 50,057 | 3,029 | 18,031 | 32,104 |
| `numbers/divide` | 2,447,845 | 1,755,232 | 51,091 | 26,063 | 18,031 | 32,104 |
| `numbers/quantity` | 3,150,230 | 1,574,354 | 83,035 | 25,531 | 14,579 | 40,088 |
| `core/loop` | 4,771,598 | 2,220,149 | 97,978 | 6,026 | 48,016 | 64,000 |

Multiplication's allocation calls fall by 93.9% and requested bytes by 53.6%.
Quantity calls fall by 69.3% and bytes by 50.0%. Group peak is unchanged:
30,336 bytes for multiplication, 31,288 for Quantity arithmetic and 26,784
for the loop. Persistent storage and Load still determine these peaks; fewer
cumulative scratch requests do not imply a lower peak or resident-memory use.
Physical caps and logical budgets are unchanged.

Separate two-second `sample` profiles of `numbers/multiply` support the
source-level attribution. Before, 827 of 1,497 Pump samples sit under
`calculateInternal`, including managed integer scaling, multiplication,
allocation and freeing. After, 36 of 1,402 Pump samples sit under that
function, and the profile contains no managed big-integer frames. Value
construction, dispatch and instruction accounting remain. These samples
describe this workload and include compiler inlining effects.

Focused allocator tests distinguish scratch storage from result storage:
the general add/subtract/multiply operators allocate scratch and free it all;
successful exact operators make zero allocation attempts, even with an
allocator configured to refuse its first request. Value arithmetic still
allocates exactly one immutable `Value` node per result. Refusing that node
reports `OutOfMemory` and leaves both operands intact. The optimization does
not replace or mutate Value storage.

## Scope and equivalence

The exact path uses checked `u128` addition, subtraction and multiplication.
Unequal exponents are aligned with checked powers of ten; nonzero scaling
over 38 places falls back before attempting wide work. Zero can be aligned
without scaling. The magnitude subtraction chooses the sign explicitly,
and zero retains the representable exponent nearest the ideal with no
negative sign.

A nonzero result returns directly only when its coefficient has at most 34
digits and its ideal exponent is already representable. Unbounded Base Unit
comparison intermediates may retain positive exponents, as before. Anything
requiring rounding, exponent adjustment or wider storage falls back to the
unchanged general rational implementation. Division, `div` and `mod` also
retain that implementation. There is no binary floating-point substitution.

The general path remains a private independent test oracle. 6,480
differential comparisons cover representative/generated operands, signs,
zero/cancellation, unequal exponents, 34-digit boundaries, scaling/product/sum
overflow, half-even ties, exponent limits and bounded/unbounded behavior.
Every successful exact case is repeated with an allocator that refuses all
requests. Fallback tests fail each allocation in turn and verify cleanup for
wide scaling, wide multiplication and subnormal rounding.

## Reproduction and validation

Build the baseline and optimized revisions separately with `zig build` in
`impl/zig`, keeping the default `safe` optimization. Compile the same Host
against each revision's library, saving the resulting binaries as `before`
and `after`:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c impl/zig/zig-out/lib/libtalk.a -o .cache/bench-zig/host
python3 bench/zig/decimal-paths.py /path/to/before /path/to/after \
  --before-revision 05b24173285e4ed19271c5f7fa72ab87a109427d \
  --pairs 3 --count 5 --out /path/to/results.json
```

Validation on the optimized checkout:

- `zig build test --summary all`: all 167 tests and the native C Host tests
  pass, including differential arithmetic, allocation refusal, immutable
  results and existing Quantity tests.
- `zig build corpus`: all 426 cases pass, including ordinary and restored
  Trace replay, resource limits, rollback and Quantity behavior. Blessed
  expectations and the Spec are unchanged.
- Safe WASI reactor build and `uv run tools/wasi/zig.py`: pass, including
  physical-cap containment and healthy fresh Groups after refusal.
- The same Corpus runner compiled for WASI passes all 426 cases in Wasmtime,
  including both Trace replays. For this check its `../../corpus` paths were
  adapted to `corpus`, with the repository root preopened. The macOS C-header
  translator needed `zig translate-c -target wasm32-wasi -lc include/talk.h`
  to select WASI headers; this affects the test Host, not the reactor.
- The Decimal tests also pass directly under WASI: a temporary test root in
  `impl/zig/src` containing `test { _ = @import("decimal/decimal.zig"); }`
  was compiled with `zig test -Osafe -target wasm32-wasi --test-no-exec` and
  executed in Wasmtime. All 12 tests pass, including the same 6,480 comparisons
  and allocation-refusal checks on wasm32.
- `bun run bench --filter numbers --smoke`: all available Cores and peers
  pass, with matching Core Fuel. Smoke timings are not used above.
- Zig fuzz witnesses/mutations, Unicode/generated/API checks, Zig formatting,
  repository Spec/docs checks, lint and formatting checks pass.
