# TS Unit metadata and conversion plans, 2026-10-15

Evidence for [#941](https://github.com/odogono/odgn-talk/issues/941).
Baseline: `f51ad856e37d802b8865bb2870c3adebc293e7d1`. The optimized source is
identified by the SHA-256 of `git diff -- impl/ts/src` in the paired JSON.
No changes from the Decimal execution scope (#944) are included.

## Implementation and limits

Unit constructors take ownership of deeply frozen slots; Quantity results reuse
owned slots instead of copying their arrays. Weak metadata caches reuse normal
text, dimension signatures and ordered factor sequences. Factor plans retain at
most 128 factors per live Unit. Larger plans and mutable caller-owned Units use
the general path. A pair of immutable operand identities can reuse multiplication
and division Units; the weak cache resets after 256 retained combinations.

Each loaded code unit prepares its distinct static `as`/`can be` Unit targets.
Reload and Restore rebuild those plans. No global cache retains arbitrary
conversion strings. Decimal multiplication/division, including identity factors,
still executes in the prescribed order with rounding at every step. The Spec,
expectations, logical accounting and save format are unchanged.

## Validation

The full TS test suite and full TS corpus pass. Focused tests cover ratio factors,
compound Units, dimension cancellation, empty Units, Calendar restrictions,
noncanonical Decimal cohorts, mutable caller slots, combination eviction,
preemption, Restore and Reload. The browser-target Core bundle builds.

`bench/ts/src/check-unit-paths.ts` compares complete Traces, pump reports with
Value Encodings, Fuel and allocation faults, canonical saved bytes and Reload
reports across both checkouts. The paired runner rejects a mismatch, as it does
for every measured Run's output, Fuel and logical allocation.

## Timing protocol

`bench/ts/unit-paths.py` runs three alternating pairs (before/after,
after/before, before/after), in fresh Bun processes, with the identical measurement
harness in both checkouts. Full-size workloads include Quantity arithmetic,
17-Fuel slicing, ratio/compound conversions and representative scalar, macro and
Load checks. Each loaded Script receives 20 validation warm-ups and another 20
after the Load measurement and an untimed full GC; mitata then warms and
samples automatically. Load uses fresh Script names. Timing processes have no
heap callbacks or CPU profiler; separate processes collect CPU and GC/heap data.

An initial trial was discarded after unrelated CPU-heavy jobs in other worktrees
produced large swings even in scalar controls. The measurement runner waits for
aggregate host CPU usage below 80% for three checks five seconds apart before
starting each pair, bounded to five minutes. During measurement it samples CPU
usage once a second and rejects a pair if other processes exceed 120% aggregate
CPU for three consecutive samples. Bun's own parallel GC/JIT work remains part
of its costs; the observer's Python/`ps` processes are excluded. Load averages and
CPU samples are retained as additional host context; timing remains advisory.


## Paired Run results

The [raw JSON](2026-10-15-ts-unit-paths.json) retains all six process summaries,
CPU observations, lifecycle equivalence data and separate probes. All three
accepted pairs passed the contention rule; none were discarded in this final
batch. Each cell below shows the median of the three process medians, with
their minimum–maximum spread in parentheses. Changes are the median and range
of the three paired percentage changes. Full per-process sample minima, maxima
and counts are in the JSON. Times are microseconds.

The JSON includes the exact executed harness source and its hash. After
collection, only its result summarizer changed from `toSorted` to sorting a copy
to meet the repository's ES2022 typecheck target; timed callbacks are unchanged.
The current helper's hash is recorded separately.

| Workload | Before µs (range) | After µs (range) | Paired change (range) |
| --- | ---: | ---: | ---: |
| `core/loop` | 3245.88 (3071.88–3314.54) | 3115.67 (3045.62–3152.83) | -6.0% (-6.2–+2.6%) |
| `numbers/divide` | 2300.50 (2294.04–2301.04) | 2289.58 (2268.12–2307.67) | -0.5% (-1.1–+0.3%) |
| `numbers/quantity` | 4100.83 (4063.58–4109.42) | 2661.83 (2626.96–2666.67) | -35.1% (-35.9–-34.5%) |
| `macro/game-tick` | 6132.83 (6099.65–6166.44) | 4311.96 (4301.21–4350.12) | -29.5% (-29.7–-29.5%) |
| `lifecycle/load-small` | 5.30 (5.25–5.30) | 4.94 (4.79–5.15) | -6.9% (-8.7–-2.7%) |
| `quantity/sliced` | 5818.83 (5782.96–5837.08) | 4463.42 (4456.88–4473.85) | -23.1% (-23.6–-22.8%) |
| `quantity/ratio-compound` | 3728.19 (3720.85–3752.00) | 2701.06 (2614.96–2715.35) | -28.0% (-29.7–-27.2%) |

Quantity Run time falls by **35.1%** at the median paired change, with a
34.5–35.9% reduction across the three pairs. Sliced Quantity improves by
22.8–23.6%, and the ratio/compound workload by 27.2–29.7%. Scalar division stays
within 1.1%; scalar loop changes range from a 2.6% increase to a 6.2% decrease.
The scalar game-tick control also improves consistently despite containing no
Units: these are whole-patch measurements, including interpreter/JIT code-shape
effects, and that gain is not attributed specifically to Unit metadata.

## Paired Load results

| Workload | Before µs (range) | After µs (range) | Paired change (range) |
| --- | ---: | ---: | ---: |
| `core/loop` | 100.08 (98.67–100.50) | 101.90 (101.21–105.08) | +1.8% (+0.7–+6.5%) |
| `numbers/divide` | 96.00 (94.96–112.83) | 120.21 (98.90–120.58) | +25.6% (-12.4–+26.6%) |
| `numbers/quantity` | 145.04 (143.88–146.04) | 117.75 (117.67–118.04) | -18.6% (-19.4–-18.2%) |
| `macro/game-tick` | 200.29 (199.88–202.29) | 190.50 (189.21–192.50) | -5.3% (-5.8–-3.9%) |
| `lifecycle/load-small` | 29.55 (29.40–29.57) | 27.67 (27.61–28.23) | -5.9% (-6.5–-4.5%) |
| `quantity/sliced` | 104.25 (104.17–104.42) | 96.50 (95.88–97.04) | -7.4% (-8.2–-6.9%) |
| `quantity/ratio-compound` | 160.75 (159.54–162.58) | 161.29 (159.62–161.96) | -0.4% (-0.7–+1.1%) |

Load remains separate from Run. Static conversion targets are prepared during
Load; there is no claim that module initialization or Load became faster.

The grouped scalar-division Load control has a wide spread, so a separate
[isolated control](2026-10-15-ts-unit-divide-control.json) repeats it in fresh
processes, using the same harness with `timing numbers/divide`. Three alternating
pairs measured Load changes of **+10.3%, +14.0%, +2.1%**, or a median increase
from 98.63 to 109.54 µs. Run changes were −0.8%, +2.3%, +2.4%. This small scalar
Load regression is a measured tradeoff of the patch; it is not hidden by the
Quantity Run improvement. No universal Load improvement is claimed.

## Separate CPU and GC/heap probes

CPU profiles use 20 warm-ups followed by three seconds of repeated, validated
full-size Quantity Runs. They are separate from all timing processes. The table
uses samples beneath `machine.ts` `execute`/`step` frames as its Pump denominator;
Unit and Decimal stack categories overlap and must not be added. JIT inlining
limits attribution. GC sample counts are process-wide.

| Profile | Pump samples | Unit stacks | Decimal stacks | `factorsOf` exclusive | GC / all samples |
| --- | ---: | ---: | ---: | ---: | ---: |
| before | 1916 | 869 (45.4%) | 700 (36.5%) | 170 | 1 / 2062 |
| after | 1844 | 573 (31.1%) | 849 (46.0%) | 0 | 1 / 2048 |

Compressed raw profiles: [before](2026-10-15-ts-unit-paths-profiles/before.cpuprofile.gz)
and [after](2026-10-15-ts-unit-paths-profiles/after.cpuprofile.gz). Profile sample
percentages are attribution evidence, not speedup estimates.

The heap probe forces a full GC before each of 30 isolated Runs and records
uncollected cell-count deltas, then compares retained heap after another 100
Runs and a full GC. These are JSC-wide observations, not exact native allocation
counts or byte totals. Instrumentation, JIT activity and automatic GC can affect
them. RSS is saved separately and is not treated as allocated JS bytes.

| Median cell delta per Quantity Run | Before | After |
| --- | ---: | ---: |
| Array | 53,383 | 28,883 |
| Object | 37,784 | 32,289 |
| string | 18,423 | 17,444 |
| BigInt | 11,967 | 12,467 |

| Retained heap after full GC | Before 100 Runs | After 100 Runs |
| --- | ---: | ---: |
| before | 7,005,470 bytes | 7,144,455 bytes |
| after | 6,913,369 bytes | 7,080,528 bytes |

The Array-cell reduction supports lower traversal/allocation overhead. Retained
heap includes runtime/JIT state and does not isolate the Unit cache; cache bounds
come from the explicit 128-factor and 256-combination limits and weak ownership.
No allocation-byte or GC-throughput claim is inferred from these probes.

## Limited four-way comparison

The exact requested command completed successfully:

```sh
bun run bench --only zig,ts,applescript,gopher-lua --count 3
```

The [full report](2026-10-15-ts-unit-four-way.md)
and [JSON](2026-10-15-ts-unit-four-way.json)
contain 111 measurements: 30 Zig, 39 TS, 21 AppleScript and 21 GopherLua.
Expected outputs passed and Fuel agreed on every overlapping Core workload.
The host is a 10-core Apple M5 with 24 GiB, darwin arm64, Bun 1.4.3, Zig 0.17.0
(native safe, C Host `-O2`), Go 1.27.2, GopherLua 1.1.2 and AppleScript 2.8.
Language version is 1.0-rc.3 and Cost Model version is 0.

Unrelated worktrees were running CPU-heavy jobs during this comparison. Its
absolute timings and cross-language ratios are advisory and are not evidence of
the optimization's speedup. The suite retains minima, medians and counts rather
than maxima; the available Quantity sample spread is shown below, with Load and
Run kept separate. Peer Load is not measured.

| Runner | Run minimum–median | Run samples | Load minimum–median | Load samples |
| --- | ---: | ---: | ---: | ---: |
| Zig | 442.61–442.73 µs | 3 | 9.224–9.279 µs | 3 |
| TS | 3023.29–3709.58 µs | 137 | 121.209–146.438 µs | 3312 |
| AppleScript | 146.13–146.71 µs | 3 | — | — |
| GopherLua | 23.94–25.82 µs | 3 | — | — |

Both NorthTalk Cores report Quantity Fuel **14,579** and logical allocation
**40,088 bytes**. Default-suite TS `hostBytes` is a process-RSS delta reported by
its existing mitata heap callback, not a count of allocated JS bytes; the
separate heap probe provides object-count evidence instead.

## Integration and implementation handoff

Measurements isolate this Unit change on `f51ad856`, before the separate TS
charging optimization (#942). The PR is rebased onto newer `main` for integration;
these timings do not claim the combined performance of both optimizations.

- **Implemented in:** this PR on `fix/issue-941`, identified by the Core
  diff hash in the paired JSON; immutable Unit metadata, bounded combination
  reuse, static conversion plans, semantic checks and measurement evidence.
- **Remaining work:** maintainer review and merge, then reconcile #941's tracker
  handoff with the merged commit. The four-way report's contention limitation
  must accompany any use of its absolute timings.
- **Required base:** `f51ad856e37d802b8865bb2870c3adebc293e7d1`, with the existing
  Unit and Number rules in `spec/03-values.md`.
- **Approval still needed:** none for expectations or Spec; neither changed.
