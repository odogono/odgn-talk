# Zig List construction and point-write measurements, 2026-10-14

Evidence for [#924](https://github.com/odogono/odgn-talk/issues/924), comparing
baseline `8f98a485` with this working tree. The
[raw paired measurements](2026-10-14-zig-list-paths.json) retain every sample, allocation probe, sweep source, accounting total and binary/source
hash, plus the targeted rechecks and discarded annotation trial.
The baseline includes the focused four-runner harness from #922 and the division changes from #923.

## Implementation and limits

`list-append` and `list-extend` now use the existing `listGrow` machinery.
Collecting no longer builds an ArrayList copy followed by another retained
List copy on every pass. Lower-ranked additions to the newest span fill spare
capacity; geometric buffer growth makes scalar collecting's spine work
amortised linear. Empty extensions retain the existing value. Earlier slices,
branches and nested/self-insertion retain their previous visible contents.
Higher-ranked insertions and growth from older spans still copy.

In-bounds scalar item writes call `listSet` with a retained borrowed root,
removing their temporary spine. The setter copies shared spines directly into
the requested Group allocator, retaining each resulting child once. Cached
logical sizes and ownership ranks avoid rescanning unchanged children. A
saturated size is remeasured after replacement, so replacing huge children can
recover an exact size. Unique same-allocator storage can be reused for
lower-ranked children; equal or higher ranks copy, preserving decreasing ranks
along physical ownership edges, including hidden List tails.

The machine's lowering temporaries and rollback bindings still retain the
input of a chunk write. Consequently those writes copy one whole visible
spine per replacement; this change does not make arbitrary List point writes
constant time or introduce a persistent tree. Padded and range writes retain
their existing rebuilding paths. Ordinary append/prepend already used spare
capacity and are not reimplemented. The [Core guide](../../impl/zig/README.md)
owns the supported behavior and these limitations.

## Method

Native Zig 0.17.0 `safe` and C Host `-O2`, Apple M5, macOS 27.0.1, arm64,
language 1.0-rc.3 and Cost Model 0. Timings use the default allocator and exclude
Load. Each process validates output and accounting, then averages complete
Runs over at least 50 ms per sample. Paired measurements use five samples per
process, three pairs and alternating before/after process order. No builds,
tests or profiling from this thread run during the final timing passes; other
work on the machine remains uncontrolled, so timings are advisory.

Untimed probes use `NORTHTALK_BENCH_ALLOCATIONS=1`. Bytes and allocation calls
are cumulative Group allocator requests during Delivery/Pump, excluding Load,
process-owned Host values and returned bytes. They are not resident memory;
frees do not subtract. The Group peak includes Load and spare capacity. The
counting allocator's resizing differs from the default timing allocator.

Reproduction, after building each native `talk.h` Host as in
[`measure-zig.ts`](../ts/src/measure-zig.ts):

```sh
python3 bench/zig/value-allocations.py <before-host> <after-host> --before-revision 8f98a485 --out paired.json
python3 bench/zig/list-scaling.py <before-host> --out before-scaling.json
python3 bench/zig/list-scaling.py <after-host> --compare before-scaling.json --out after-scaling.json
bun run bench --only ts,zig,applescript,gopher-lua --count 3
```

The selected comparison runs only native Zig, the TS Core, AppleScript and
GopherLua. No WASM or other Peer Language performance run is part of it.
WASI runs below are correctness and containment checks.

## Paired workload timings

The median of the three process medians, in milliseconds. The two Load rows
use Load samples; other rows use complete Run samples.

| Workload | Before ms | After ms | Speedup |
| --- | ---: | ---: | ---: |
| `core/loop` | 1.316 | 1.328 | 0.99× |
| `core/fib` | 0.951 | 0.959 | 0.99× |
| `core/fib@slice=10` | 4.864 | 5.222 | 0.93× |
| `core/fib@slice=100` | 1.379 | 1.361 | 1.01× |
| `core/fib@slice=1000` | 0.998 | 0.986 | 1.01× |
| `core/fib@slice=10000` | 1.001 | 0.955 | 1.05× |
| `core/calls` | 0.910 | 0.905 | 1.01× |
| `core/lambdas` | 1.230 | 1.226 | 1.00× |
| `numbers/add` | 0.676 | 0.678 | 1.00× |
| `numbers/multiply` | 0.438 | 0.437 | 1.00× |
| `numbers/divide` | 0.461 | 0.461 | 1.00× |
| `numbers/quantity` | 0.471 | 0.471 | 1.00× |
| `text/build` | 0.475 | 0.473 | 1.01× |
| `text/iterate` | 0.732 | 0.737 | 0.99× |
| `text/index` | 1.034 | 1.034 | 1.00× |
| `text/patterns` | 0.662 | 0.645 | 1.03× |
| `text/graphemes` | 1.369 | 1.409 | 0.97× |
| `collections/list-build` | 0.823 | 0.313 | 2.62× |
| `collections/list-append` | 1.401 | 1.444 | 0.97× |
| `collections/map-build` | 1.010 | 0.988 | 1.02× |
| `collections/list-update` | 0.822 | 0.798 | 1.03× |
| `collections/map-update` | 0.297 | 0.298 | 1.00× |
| `collections/iterate` | 2.219 | 2.212 | 1.00× |
| `host/pump` | 0.002 | 0.002 | 0.99× |
| `macro/transform` | 0.711 | 0.410 | 1.73× |
| `macro/report` | 1.259 | 1.251 | 1.01× |
| `macro/game-tick` | 1.705 | 1.707 | 1.00× |
| `messaging/suspend` | 3.334 | 3.267 | 1.02× |
| `lifecycle/load-small (Load)` | 0.003 | 0.003 | 1.00× |
| `lifecycle/load-large (Load)` | 0.758 | 0.771 | 0.98× |

List construction improves by 2.62× and invoice transformation by 1.73×.
The eight-item update workload improves by only 1.03×. Ordinary List append,
which already used spare capacity, has identical allocation requests.

## Size scaling

Each cell uses the median of three process medians (five samples per process).
Scalar collecting is the manifest checksum workload. The spread probe collects
`[...[i]]`, exercising both literal extension and collecting. The write probe
loads an immutable Constant of N integers, then replaces the last item 128
times with the original retained; seed construction happens during Load.

| Probe | N | Before ms | After ms | Before requested bytes | After requested bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| `collect` | 100 | 0.075 | 0.061 | 93,952 | 54,338 |
| `collect` | 300 | 0.319 | 0.180 | 500,689 | 133,555 |
| `collect` | 1,000 | 2.792 | 0.598 | 4,450,340 | 415,148 |
| `collect` | 3,000 | 27.257 | 1.866 | 37,391,253 | 1,232,133 |
| `spread` | 100 | 0.066 | 0.050 | 131,943 | 101,929 |
| `spread` | 300 | 0.303 | 0.149 | 615,479 | 277,145 |
| `spread` | 1,000 | 3.359 | 0.494 | 4,833,930 | 894,738 |
| `spread` | 3,000 | 30.542 | 1.485 | 38,542,842 | 2,671,722 |
| `write` | 100 | 0.107 | 0.086 | 123,865 | 114,745 |
| `write` | 300 | 0.230 | 0.155 | 345,465 | 319,545 |
| `write` | 1,000 | 0.674 | 0.402 | 1,121,066 | 1,036,346 |
| `write` | 3,000 | 2.839 | 1.516 | 3,337,066 | 3,084,346 |

Tripling scalar collecting from 1,000 to 3,000 items multiplies the baseline
time by 9.76 and requested bytes by 8.40. After the change, the factors are
3.12 and 2.97: measured growth agrees with amortised linear spine work. At
3,000 items the speedup is 14.61× and cumulative requests fall by 96.7%.
The third after process at that size took 3.35 ms versus 1.85–1.87 ms in the
other two; all samples remain in the raw record. Nested collecting and
ownership-rank-forced copies are not covered by the scalar scaling claim.

The 128-write probe remains proportional to List length: at 3,000 items it
improves from 2.84 to 1.52 ms (1.87×), while still copying the visible spine
for each write. Its allocation reduction is modest because the former scratch
spine was reused by the scratch arena; removing copies is not equivalent to
removing one parent allocator request per update.

## Allocation probes and unchanged logical charges

Single checked Runs, separate from timings. Calls/bytes below are Group
allocator requests; all three pairs agree on these figures.

| Workload | Calls before | After | Bytes before | After | Fuel | Logical bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `collections/list-build` | 1,035 | 554 | 1,215,090 | 219,780 | 19,091 | 3,022,112 |
| `collections/list-update` | 1,533 | 1,532 | 110,702 | 109,994 | 28,553 | 24,328 |
| `macro/transform` | 2,437 | 1,874 | 1,101,421 | 385,735 | 20,664 | 6,418,202 |
| `collections/list-append` | 2,062 | 2,062 | 825,789 | 825,789 | 52,056 | 80,200 |
| `collections/map-build` | 46,986 | 46,986 | 1,378,136 | 1,378,136 | 14,094 | 24,920 |
| `collections/map-update` | 5,041 | 5,041 | 115,233 | 115,233 | 8,056 | 12,432 |
| `collections/iterate` | 1,121 | 1,097 | 95,955 | 89,765 | 89,459 | 200,319 |

Every paired timing and counting-allocator probe preserves output, Fuel and
logical allocation. The same checks hold at every sweep size. Raw records
also retain frees, live-peak deltas, Group peaks and allocation size counts.
No Spec, Data File, Cost Model or blessed expectation changed.

For 3,000 scalar items the counting-allocator Group peak (including Load) is
1,279,243 bytes before and 1,157,193 after, a 9.5% reduction. The 96.7% figure
above describes cumulative requests, not peak live memory. Fuel stays 348,779
and logical allocation stays 108,132,112 bytes even though the physical spine
work becomes linear: `collecting` still pays Cost Model 0's full result charge.

## Broader regressions and the small Fuel Slice

The main comparison reports ordinary List append at 1.401 versus 1.444 ms
(3.1% slower), graphemes at 1.369 versus 1.409 ms (2.9% slower), and Fibonacci
at a Fuel Slice of 10 at 4.864 versus 5.222 ms (7.4% slower). Other control
medians are mostly within a few percent. These movements remain visible in
the complete table and raw samples.

A targeted five-pair recheck, with seven samples per process and the same
binary hashes, measures ordinary append at 1.333 versus 1.339 ms (0.5%), but
small-slice Fibonacci at 5.044 versus 5.771 ms (14.4% slower). The individual
small-slice before process medians range from 4.871 to 5.728 ms and after from
5.037 to 6.564 ms. This repeats the slower direction and cannot simply be
ignored because the Script has no collecting or item writes.

An inlining investigation found unchanged `Group.execute` and `Group.turns`
stack-frame sizes in native disassembly. A trial marking `listGrow` `noinline`
produces identical native `__TEXT,__text` bytes to the optimized binary; the
raw record stores its binary hash and the hash of the text-section dump.
That trial's five pairs measure 5.484 versus 5.241 ms for the same small-slice
probe (4.4% faster), and 1.334 versus 1.336 ms for append (0.2% slower).
Since the annotation changes no machine instructions, its reversed timing
is evidence of machine-level variation, not an inlining improvement. The
annotation is reverted. No causal explanation for the small-slice spread was
established; small-slice performance remains uncertain on this machine.

## Current four-runner comparison and residual gaps

The [full report](2026-10-14-zig-list-peers.md) and
[raw comparison](2026-10-14-zig-list-peers.json) record all 111 measurements:
30 native Zig, 39 TS, 21 AppleScript and 21 GopherLua. Fuel agrees across the
Cores. Zig and the peers use three repeats; TS uses mitata's automatic samples.
Bun is 1.4.3, Go hosts GopherLua v1.1.2 on Go 1.27.2, and AppleScript is 2.8.
These are separate measurements after the paired passes, so their medians
can differ from the paired table above.

| Workload | Zig ms | TS ms | AppleScript ms | GopherLua ms | Zig / AppleScript |
| --- | ---: | ---: | ---: | ---: | ---: |
| `collections/list-build` | 0.314 | 1.529 | 0.230 | 0.037 | 1.36× |
| `collections/list-update` | 0.785 | 4.531 | 0.369 | 0.026 | 2.13× |
| `macro/transform` | 0.387 | 3.128 | 0.334 | 0.123 | 1.16× |

The residual AppleScript gaps are 1.36× for List construction, 2.13× for the
short retained-List update workload and 1.16× for transformation, compared
with the issue's original 3.44×, 2.14× and 2.05× workload targets. The paired
baseline already includes #923 and is the basis for attributing this change.
Peers use idiomatic ports and native numeric types; these ratios describe
workloads, not equal instructions or promised speedups. The short update gap
largely remains, even though writes on longer Lists improve in the size sweep.

## Verification

- `zig build test corpus --summary all`: 221 Zig tests and the C Host tests
  pass; all 429 Corpus cases pass, including ordinary and restored Trace replay.
- `zig build corpus -- --defer-crossings`: all 429 cases pass unchanged.
- Focused coverage includes retained originals, branching versions, negative
  indexes, padding and ranges, nested/self-insertion, ownership ranks, shared
  backing slices, foreign allocator copies, saturated logical sums, and
  allocation-failure cleanup. The Group cap sweep now exercises collecting,
  literal spreading and item writes with snapshots retained.
- The C Host preserves its original List while the Script collects and changes
  successive versions. Existing physical-cap and snapshot-growth tests pass.
- Native `safe` and `wasm32-wasi` builds pass. `uv run tools/wasi/zig.py` and
  `uv run tools/wasi/check.py` both pass the C API, containment and Message
  Layer checks. The final reactor is 3,022,104 bytes raw and 688,947 Brotli;
  the small instance uses 2,162,688 bytes of linear memory.
- `bun test tests/zig-runner.test.ts` in `tooling/fuzz`: both tests pass, with
  33 assertions comparing complete TS/Zig witness and mutation Traces.
- `bun run check`, `bun run lint`, `bun run format:check`,
  `bun run zig:check`, `bun tools/zig/api.ts`, `zig fmt --check impl/zig` and
  `git diff --check` pass. Unicode 18.0.0's ten pinned data files are verified.

All expected records stay unchanged. No first blessing or Spec change is
required by these implementation changes.
