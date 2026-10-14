# Zig Value allocation measurements 2026 10 14

Evidence for [#878](https://github.com/odogono/odgn-talk/issues/878), comparing
baseline `bdc8f0e0fd09e2c49ff408f6d3fcdfa93ed2f76a` (current `main`, after the
[#876](https://github.com/odogono/odgn-talk/issues/876) Map and
[#877](https://github.com/odogono/odgn-talk/issues/877) Decimal work) with this
issue's per-Group Value node cache. The
[raw measurements](2026-10-14-zig-value-allocations.json) preserve three
before/after pairs over all 30 supported workloads (including the Fuel Slice
sweep), every timing sample, allocation probes, source hashes and
machine/toolchain settings. Reproduce with `bench/zig/value-allocations.py`.

On Apple M5, macOS 27.0.1, arm64, Zig 0.17.0 in `safe` mode and a C Host built
with Apple clang 21.0.0 at `-O2`, the cache removes nearly every parent
allocation from scalar-heavy Runs (for example `core/loop` falls from 6,027 to
25 allocation calls per Run), is timing-neutral with Zig's default allocator
(geomean ratio 0.992 across 30 workloads), and is 7–9% faster on
arithmetic/call workloads when the Host supplies its own C allocator. Fuel and
logical allocation are identical in every pair, and Group peak memory is
unchanged within one retained node. The language version was 1.0-rc.3 and Cost
Model 0.

## What the probe counts

The probe wraps the allocator the Host hands the Group through
`talk_allocator`, enabled only when `NORTHTALK_BENCH_ALLOCATIONS` is set;
default-allocator timings never see it. Figures cover one checked Run
(Delivery and Pumps), excluding Load: `hostBytes`/`hostAllocs` are cumulative
parent-allocator requests (frees do not subtract), `hostFrees` counts free
calls, `hostLivePeakDelta` is the largest rise in live requested bytes above
the level at Run start, and `hostTopSizes` lists the exact request sizes with
the most requests. `groupPeak` is the Group's own physical high-water mark,
including Load. Process-owned Host values and returned bytes are outside this
allocator. None of these is resident memory.

## Where the allocations were (baseline)

A Value node is 368 bytes, so its request size names it in the probe. Data is
a 304-byte union whose largest member is a Quantity: Decimal (32 bytes) plus a
Unit (256 bytes of inline dimension slots).

| Workload | Allocs | Frees | Requested bytes | Live peak rise | Top request sizes |
| --- | ---: | ---: | ---: | ---: | --- |
| core/loop | 6,027 | 6,021 | 2,220,293 | 9,326 | 368 B ×6,005 (99.6%) |
| numbers/add | 4,030 | 4,024 | 1,485,058 | 9,326 | 368 B ×4,007 (99.4%) |
| core/calls | 10,027 | 10,021 | 2,555,949 | 9,326 | 368 B ×6,004, 144 B ×2,003, 24 B ×2,000 |
| collections/iterate | 7,822 | 7,817 | 2,561,459 | 35,083 | 368 B ×6,773 (86.6%) |
| collections/list-build | 2,037 | 2,032 | 1,583,362 | 205,969 | 368 B ×1,509; large List buffers hold most bytes |

Scalar Value allocation is the dominant request count everywhere profiled, and
frees match allocations: only about 25 nodes are live at once in `core/loop`,
`numbers/add` and `core/calls` (a 9,326-byte live rise). After #877, Decimal
scratch no longer appears among leading sizes in these workloads.
`collections/list-build` differs: its 500 result nodes are retained, not
churned, and collection buffer copying holds most requested bytes, so the
October gap against Go on that workload was never evidence for this cache.

## The improvement

The Group allocator keeps at most 128 freed Value nodes (368 bytes each, at
most 47,104 retained bytes), linked through their first word, and serves the
next node allocation from that list. Retained nodes count in the Group's
physical `used`, so the physical cap still bounds everything; cap pressure
flushes the cache to the parent before refusing, and Group release returns
every cached node. Host/process values keep their own allocator and are never
cached. Overflowing the bound, and every other size, go straight to the
parent, so repeated Runs cannot grow retained memory without bound.

Parent requests per Run after the change: `core/loop` 6,027 → 25,
`numbers/add` 4,030 → 27, `core/calls` 10,027 → 4,028 (the remaining 144-byte
and 24-byte per-call records are untouched), `collections/iterate` 7,822 →
1,121, and `collections/list-build` 2,037 → 1,035 (its 500 retained nodes and
List buffers). Group peak is unchanged on 26 workloads and rises by at most
3,349 bytes on the rest: retained cache, as counted.

## Paired timings

Each figure is the median of three per-process medians; each process takes
five samples averaging complete Runs over at least 50 ms, after one untimed
validation Run. With Zig's default allocator (`smp_allocator`, itself a
size-class free-list allocator, which already made LIFO node churn cheap),
the geomean after/before ratio is 0.992 and every workload is within ±5.1%;
no workload regresses beyond noise. With the probe's Host-supplied
`posix_memalign` C allocator (a supported `talk_allocator` configuration,
three paired sets of five samples):

| Workload | Before ms | After ms | Change |
| --- | ---: | ---: | ---: |
| core/loop | 1.543 | 1.415 | −8.3% |
| numbers/add | 0.795 | 0.726 | −8.8% |
| core/calls | 1.127 | 1.046 | −7.2% |
| collections/iterate | 2.483 | 2.417 | −2.6% |
| collections/list-build | 0.695 | 0.719 | +3.5% |

## Judgment and the next bottleneck

The hypothesis is confirmed as an allocation profile but only partly as a
time profile: node churn was almost all of the parent traffic, yet the
default allocators (native `smp_allocator`, WASI `wasm_allocator`) had
already made that traffic cheap. The cache is kept because it removes the
dependence on parent-allocator speed for the hottest request size — worth
7–9% for Host-supplied allocators, neutral for the defaults — at a bounded,
counted retention.

What allocator removal exposes as the remaining costs, in order: the 368-byte
node itself (every temporary writes and reference-counts a node sized by the
256-byte inline Unit; boxing the Quantity payload is a representation rewrite
that needs its own measurements), the 144-byte and 24-byte per-call records
in `core/calls` and `core/fib`, and per-instruction bookkeeping, which is
[#879](https://github.com/odogono/odgn-talk/issues/879).
