# Measurement records

Each entry records what a saved result in this directory measured, for which issue, and how to repeat it. Read these for history; [the suite guide](../README.md) covers running, comparing and profiling.

The [first full wave 1 results](2026-10-06-darwin-arm64-apple-m1-pro.md) cover all 26 workloads on an Apple M1 Pro, with matching Fuel on both Cores. The [JSON](2026-10-06-darwin-arm64-apple-m1-pro.json) records all 192 measurements. The [first full results with wave 2](2026-10-08-darwin-arm64-apple-m5.md) cover all 38 workloads, including the four Fuel Slice sweep runs, on an Apple M5. Their [JSON](2026-10-08-darwin-arm64-apple-m5.json) records 216 measurements.

The [first results with AppleScript](2026-10-09-darwin-arm64-apple-m5.md) cover all 39 workloads on an Apple M5, with AppleScript on the 21 that the Peer Languages run. Their [JSON](2026-10-09-darwin-arm64-apple-m5.json) records 246 measurements.

The [first native Zig comparison](2026-10-14-darwin-arm64-apple-m5.md)
covers 39 workloads on an Apple M5, with Zig on 30 of them, including all 21
Peer Language workloads. Its [JSON](2026-10-14-darwin-arm64-apple-m5.json)
records 276 measurements with matching Fuel across the overlapping Cores.

The [focused Zig, TS, AppleScript and Lua comparison](2026-10-14-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua.md)
records 111 measurements on an Apple M5: 30 Zig workloads, 39 TS workloads and
21 each on AppleScript and GopherLua, with matching Fuel on the overlapping
Cores. Its [JSON](2026-10-14-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua.json)
records three repeats for Zig and the peers, and mitata's automatic TS samples.

The [Zig Map write measurements](2026-10-14-zig-map-writes.md) record
three paired before/after runs, construction scaling and Group allocation
probes for [#876](https://github.com/odogono/odgn-talk/issues/876).

The [Zig Decimal arithmetic measurements](2026-10-14-zig-decimal-paths.md)
record three paired runs across all 30 supported workloads, separate allocation
probes and native/WASI equivalence checks for
[#877](https://github.com/odogono/odgn-talk/issues/877).

The [Zig Decimal comparison measurements](2026-10-15-zig-comparison-paths.md)
record exact comparison probes, paired loop/Fibonacci and broader timings,
separate CPU captures and allocation checks for
[#939](https://github.com/odogono/odgn-talk/issues/939). Build two native Hosts
as `ts/src/measure-zig.ts` does, then reproduce them with:

```sh
python3 bench/zig/comparison-paths.py <before-host> <after-host> --before-revision <sha> --profiles <profile-directory> --out <results.json>
```

This includes every supported manifest workload and nine comparison probes.
Use repeated `--filter` options to select a subset. Timed Runs use the default
allocator; separate counting-allocator probes require identical output, Fuel,
logical allocation and Group allocation counters. Optional macOS profiles
sample only after all paired timings finish.

The [Zig division and Unit measurements](2026-10-14-zig-division-paths.md)
record paired exact division, `div`/`mod` and Quantity timings, allocation
probes, native/WASI equivalence and the residual AppleScript gaps for
[#923](https://github.com/odogono/odgn-talk/issues/923).

The [Zig Unit metadata measurements](2026-10-14-zig-unit-metadata.md)
record static conversion descriptors and ordered plans, compact Unit payloads,
paired conversion/comparison probes, separate CPU captures and surviving-copy
assembly. `zig/unit-paths.py` reproduces the paired suite and optional macOS
profiles against two prebuilt native Hosts.

The [remaining Zig numeric-path measurements](2026-10-19-zig-number-paths.md)
record Quantity arithmetic and conversion, coefficient-one division, constructor
inlining controls, full-suite pairs and the four-runner numeric comparison for
[#1290](https://github.com/odogono/odgn-talk/issues/1290).

The [Zig Character indexing measurements](2026-10-14-zig-character-indexing.md)
record paired forward-index improvements, scaling, negative-index limits and
the fresh four-runner text comparison for
[#927](https://github.com/odogono/odgn-talk/issues/927).

The [Zig Text construction measurements](2026-10-15-zig-text-growth.md)
record trusted concatenation, exact ASCII metadata, growth sweeps and the
four-runner comparison for [#957](https://github.com/odogono/odgn-talk/issues/957).
For paired Text construction and length/growth sweeps, build two native Hosts
as above and run:

```sh
python3 bench/zig/text-growth.py <before-host> <after-host> --before-revision <sha> --profiles <directory> --out <results.json>
```

This includes every supported manifest workload and ASCII/Unicode probes that
vary the append count and operand length. All timing pairs finish before
counting-allocator probes and optional macOS CPU captures. Outputs, Fuel and
logical allocation must agree. Explicit Text byte-write volumes are calculated
from the generated growth inputs and reported separately from measured Group
allocation requests; they are not memory-bus counters.
Use `--profiles-only` with an existing `--out` file and the same binaries and
runtime sources to capture profiles separately without repeating timings.

For paired Character indexing measurements, including fixed-index probes that
exclude modulo and equality, build two native Hosts as above and run:

```sh
python3 bench/zig/character-indexing.py <before-host> <after-host> --before-revision <sha> --out <results.json>
```

This includes the full-size text workloads and 16-, 256- and 4,096-Character
inputs read near the start, at the end and with a negative index. Timing and
allocation probes run separately and require identical output, Fuel and logical
allocation. Each process also repeats Runs against the same loaded Script.

The [Zig List measurements](2026-10-14-zig-list-paths.md) record
collecting and item-write size sweeps, paired collection and transform timings,
allocation probes and residual AppleScript gaps for
[#924](https://github.com/odogono/odgn-talk/issues/924).

The [Zig item-write measurements](2026-10-19-zig-list-item-writes.md)
compare replacement with append, paired instruction and ownership workloads,
and AppleScript for [#1291](https://github.com/odogono/odgn-talk/issues/1291).

The [Zig Value allocation measurements](2026-10-14-zig-value-allocations.md)
record the size-attributed allocation profile, three paired runs across all 30
supported workloads and Host-allocator timings for the per-Group Value node
cache in [#878](https://github.com/odogono/odgn-talk/issues/878).

The [Zig scalar constructor measurements](2026-10-14-zig-scalar-constructors.md)
record narrow Number, Boolean and Nothing construction, safe native assembly,
paired scalar-heavy and broader timings, and separate allocation probes for
[#937](https://github.com/odogono/odgn-talk/issues/937).

The [Zig operand storage measurements](2026-10-14-zig-operand-storage.md)
record paired sliced/unsliced timings, native disassembly and CPU samples for
reusing protected-operand storage in
[#925](https://github.com/odogono/odgn-talk/issues/925).

The [Zig scratch reset measurements](2026-10-15-zig-scratch-reset.md)
record alternating sliced/unsliced timings, protected-loop probes, allocation
parity, native assembly and separate CPU samples for skipping already-empty
instruction arena resets in
[#956](https://github.com/odogono/odgn-talk/issues/956).

The [TS Load optimization measurements](2026-10-09-ts-load.md) record
three paired before/after runs for [#505](https://github.com/odogono/odgn-talk/issues/505).

For isolated TS Cost Model comparisons, run:

```sh
bun bench/ts/src/compare-costs.ts <before-ref> .cache/cost-comparison
```

The [TS accounting measurements](2026-10-15-ts-costs.md) retain the
paired Run timings, separate CPU/heap evidence and four-runner Load/Run spread
for [#942](https://github.com/odogono/odgn-talk/issues/942).

The [TS instruction overhead measurements](2026-10-26-ts-instruction-overhead.md)
record three main/candidate pairs for every `core/*`, `macro/*` and `collections/*`
workload, plus Node Fibonacci samples, for [#1580](https://github.com/odogono/odgn-talk/issues/1580).

The two bundles share the current sources except that the before bundle reads
`impl/ts/src/costs.ts` from the named revision. Both bundles run in one process;
each workload warms up for 20 Runs per variant, then runs three rounds of seven
paired batches of 20 full-size Runs, alternating AB/BA within each round.
`timings.json` retains every batch mean, output, exact Fuel and logical
allocation; a mismatch fails the comparison. Separate heap probes record JSC
and process memory before and after 100 Runs and after a forced full GC, with
the final GC's duration. These are memory observations, not total allocation
counts. The four-runner JSON summaries also retain `maxNs` alongside their
minimum, median and sample count; older reports may omit it.
An optional third argument selects an exact workload name.

Profile the resulting bundles separately from timing, for example:

```sh
bun --cpu-prof --cpu-prof-dir=.cache/cost-comparison .cache/cost-comparison/before.js profile macro/transform
bun --cpu-prof --cpu-prof-dir=.cache/cost-comparison .cache/cost-comparison/after.js profile macro/transform
```

Profile mode repeats validated Runs for three seconds after warm-up. Profiles
also contain process startup, Load, validation and warm-up; their sample shares
do not establish a timing speedup.

The [TS messaging and lifecycle measurements](2026-10-18-ts-messaging-lifecycle.md)
record alternating batches with both Core initialization orders, separate CPU
and heap probes, and traced/untraced equivalence for
[#1292](https://github.com/odogono/odgn-talk/issues/1292). To reproduce:

```sh
bun bench/ts/src/compare-messaging-lifecycle.ts <before-ref> .cache/ts-messaging-lifecycle
bun bench/ts/src/compare-messaging-lifecycle.ts <before-ref> .cache/ts-messaging-lifecycle-reversed '' after
```

The helper substitutes only `group.ts` in the before bundle. An optional third
argument filters workload names; the fourth selects which Core initializes
first. It validates output, Fuel and logical allocation on every Run. Run the
commands sequentially; CPU and heap observations stay outside timing.

The [TS Text Pattern measurements](2026-10-19-ts-text-patterns.md)
record fresh-process comparisons and CPU profiles for
[#1294](https://github.com/odogono/odgn-talk/issues/1294). To reproduce:

```sh
bun bench/ts/src/compare-text-patterns.ts <before-ref> .cache/ts-patterns
bun bench/ts/src/compare-text-patterns.ts <before-ref> .cache/ts-patterns-reversed '' after
```

The helper substitutes `patterns.ts` and `values.ts` from the baseline, reuses
the chunk-read worker, and alternates three pairs of fresh Bun processes per
workload. Every Run validates output, Fuel and logical allocation. An optional
third argument selects an exact workload; the fourth selects which variant
runs first. Timings, fresh-name Load samples and heap probes are separate.
The emitted bundles accept `<workloads.json> profile text/patterns` for CPU
profiling outside timing.

The [TS range construction measurements](2026-10-15-ts-range-construction.md)
record alternating before/after timings, separate CPU profiles and heap/forced-GC
probes for [#943](https://github.com/odogono/odgn-talk/issues/943). To reproduce,
install dependencies in both checkouts, copy `ts/src/range-construction.ts` into
the baseline checkout, then run from the after checkout:

```sh
python3 bench/ts/range-construction.py <before-checkout> . --before-revision <sha> --out <results.json>
```

Each workload's before and after processes run next to one another, alternating
order over three pairs. The probe checks output, Fuel and logical allocation on
every Run, saves nine 50 ms Run samples and separate fresh-name Load samples,
then collects heap/GC evidence and compressed CPU profiles outside timing.
Host load averages accompany each process because unrelated jobs on a shared
machine can dominate small changes.

The [Go Save and Restore optimization measurements](2026-10-10-go-save-restore.md)
record before/after timings and allocations for [#504](https://github.com/odogono/odgn-talk/issues/504).

The [TS packed Unicode tables measurements](2026-10-12-ts-unicode-tables.md)
record three paired before/after runs for [#399](https://github.com/odogono/odgn-talk/issues/399).

The [TS Unit metadata measurements](2026-10-15-ts-unit-paths.md) record
alternating Run and Load timings, separate CPU and heap probes, lifecycle
equivalence and the four-runner comparison for
[#941](https://github.com/odogono/odgn-talk/issues/941). To repeat the paired
measurements, install dependencies in both checkouts and copy
`bench/ts/src/measure-unit-paths.ts` and `check-unit-paths.ts` unchanged into the
baseline's `bench/ts/src/`, then run:

```sh
python3 bench/ts/unit-paths.py /path/to/before --before-revision <sha> --out results.json
```

The harness bounds its wait for a quiet host, validates every timed Run, and
keeps CPU profiling and GC/heap probes outside the timing processes. The JSON
records each pair's medians, minima, maxima and sample counts separately for
Load and Run.

The [TS chunk-read measurements](2026-10-15-ts-character-indexing.md)
record alternating paired timings, fixed-index length sweeps, separate CPU and
heap/GC probes, and the four-runner comparison for
[#940](https://github.com/odogono/odgn-talk/issues/940). The paired driver is
`bench/ts/character-indexing.py`; its two inputs are standalone Bun bundles of
`bench/ts/src/character-indexing-worker.ts`, built against the respective Cores.

The [TS Decimal measurements](2026-10-15-ts-decimal-paths.md) record
alternating division, integer/remainder, Quantity and indexing timings with
signed, precision-boundary and subnormal probes for
[#944](https://github.com/odogono/odgn-talk/issues/944). Run
`bench/ts/decimal-paths.py` with before/after bundles of the same
`bench/ts/src/character-indexing-worker.ts`; it reuses the paired driver with a
Decimal workload array. `bench/ts/decimal-profiles.py` collects separate CPU
captures from the saved measurements. The report also includes heap/GC
observations and the requested four-runner comparison.

The [TS List-write measurements](2026-10-19-ts-list-writes.md)
record historical iteration rechecks, paired List-update timings, retained-List
size sweeps and separate CPU/heap probes for
[#1293](https://github.com/odogono/odgn-talk/issues/1293). To reproduce:

```sh
bun bench/ts/src/compare-collections.ts <before-ref> .cache/ts-collections
bun bench/ts/src/compare-collections.ts <before-ref> .cache/ts-collections-recheck collections/list-update after
```

The helper substitutes only `list-storage.ts` and `operations.ts` from the
baseline, and reuses the chunk-read worker. Three fresh process pairs alternate
order for each workload; every Run checks output, Fuel and logical allocation.
The optional third argument filters workload names; the fourth chooses which
variant runs first. CPU profiles and heap observations stay outside timings.

For paired native Zig instruction measurements, build the same
[`talk.h` Host](../zig/host.c) against the before and after libraries, then run:

```sh
python3 bench/zig/instruction-bookkeeping.py /path/to/before /path/to/after \
  --before-revision <commit> --pairs 3 --count 5 --out /path/to/results.json
```

This includes every supported manifest workload, the Fibonacci Fuel Slice
sweep, sliced loops/calls, straight-line moves and a loop protected by
`finally`. It checks output, Fuel and logical allocation, alternating binary
order between pairs. Default-allocator timings and counting-allocator probes
are separate. On macOS, add `--profiles /path/to/reports` for separate
two-second CPU samples of both binaries after timings finish. The JSON records
overlapping inclusive sample categories; compressed raw reports retain the
call trees and offsets for attribution. The
[instruction bookkeeping report](2026-10-14-zig-instruction-bookkeeping.md)
records the compile-time rate-lookup experiment and its limits. The
[Cost Model formula measurements](2026-10-14-zig-cost-evaluation.md)
compare generated static evaluators with the term interpreter, including the
full native regression check and the remaining AppleScript gaps. For separate
captures of charging in arithmetic and Quantity workloads, pass
`--profiles-only --profile-filter numbers/add --profile-filter numbers/quantity`
alongside `--profiles`; repeated profile filters select alternatives.

The [persistent collection measurements](2026-10-10-structural-sharing.md)
compare point writes at 512 and 8,192 elements and the full collection workloads
for [#598](https://github.com/odogono/odgn-talk/issues/598). Their focused Go
benchmark was the native Go Core's, removed in #1055.

## Zig ordered Map storage

`python3 bench/zig/map-storage.py <before-host> <after-host> --before-revision <sha> --out <results.json>`
compares construction, replacement, retained versions, deletion and long keys
from empty/tiny Maps through 3,000 entries. Build both native Hosts first as in
`ts/src/measure-zig.ts`. Process order alternates across pairs; default-allocator
timings and fresh-Group allocation probes are separate. Outputs, Fuel and logical
allocation must agree. `--filter` selects a workload substring; `--max-size`
limits the sweep for small-Map rechecks. Results include source/binary hashes,
per-pair timings and both Group peak and Run live-peak delta. The review limits
are a repeatable small-Map slowdown above 5%, or peak growth exceeding the larger
of 10% and 4 KiB; timing remains advisory, never a CI gate.

The [ordered Map storage results](2026-10-15-zig-map-storage.md) record
the shared-block implementation, acceptance limits and native regression sweep.
