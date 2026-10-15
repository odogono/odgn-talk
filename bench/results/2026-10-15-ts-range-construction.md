# TS range construction, 2026-10-15

Evidence for [#943](https://github.com/odogono/odgn-talk/issues/943).
Before: `f51ad856e37d802b8865bb2870c3adebc293e7d1` (the required base).
After: the same base plus this worktree's scoped `machine.ts` change. The
[raw JSON](2026-10-15-ts-range-construction.json) pins both machine source hashes,
the probe hashes, all samples, accounting and process load averages.

The iterator derives each immutable range's integer start once from its cached
Decimal parts, holds it in a WeakMap, and constructs items through the existing
checked `integerValue` path. List and count iterators retain their general
paths. Public input validation, eager canonical formatting and immutable Value
and Decimal wrappers remain intact. Source, position, logical size and saved
iterator fields remain unchanged; Restore rebuilds the weak cache lazily.

## Paired timing

Apple M5, 10 cores, 24 GiB, macOS 27.0.1 arm64; Bun
`1.4.3+26aa4e1a9`, language 1.0-rc.3, Cost Model 0. Full-size manifest workloads
and expectations are unchanged. Each workload starts fresh before/after Bun
processes next to one another, in A/B, B/A, A/B order over three pairs. Each
process reuses one loaded Script for 20 warm-up Runs and nine samples, each
averaging validated full Runs totaling at least 50 ms. Delivery, Pump, report
collection and result display are inside Run timing; validation is outside.
Explicit GC and CPU profiling are separate phases. Load has nine fresh-name
samples after ten warm-ups and includes no Run.

Other jobs were active on the shared machine. The initial, more widely spaced
whole-suite timing attempt was discarded. Even the closer pairs below show
substantial drift: use these as observed measurements, not isolated causal
speedups. No test or benchmark from this task ran alongside the saved paired
timing processes. The unrelated jobs could not be controlled by this task.

Run columns are the median of three process medians, followed by their
minimum–maximum spread in brackets, in **ms**. Change is the median of the
three **paired ratios**, followed by their spread; it is not the ratio of the
two aggregate medians. Raw JSON also retains every within-process sample.

| Workload | Before Run ms [spread] | After Run ms [spread] | Paired change [spread] |
|---|---:|---:|---:|
| `core/calls` | 8.355 [5.209–9.665] | 6.345 [4.450–6.368] | -24.1% [-34.1–-14.6%] |
| `collections/list-update` | 7.498 [4.486–8.485] | 5.218 [4.076–5.507] | -26.6% [-38.5–-9.1%] |
| `collections/list-build` | 3.723 [2.490–4.063] | 3.099 [2.523–3.576] | -12.0% [-16.8–+1.3%] |
| `macro/transform` | 5.443 [4.364–5.494] | 5.069 [4.177–5.777] | -4.3% [-6.9–+5.1%] |
| `numbers/add` | 8.117 [6.025–8.792] | 5.631 [4.800–5.918] | -30.6% [-32.7–-20.3%] |
| `numbers/multiply` | 5.319 [5.156–5.346] | 4.018 [3.867–5.316] | -22.1% [-27.3–-0.6%] |
| `numbers/divide` | 6.079 [5.658–7.599] | 5.335 [4.382–5.641] | -22.6% [-25.8–-12.2%] |
| `numbers/quantity` | 7.610 [7.467–13.437] | 8.041 [6.618–10.733] | -13.0% [-20.1–+7.7%] |
| `core/fib` | 5.724 [4.616–6.367] | 5.605 [4.769–5.610] | -2.1% [-11.9–+3.3%] |
| `text/graphemes` | 17.576 [13.508–18.261] | 11.099 [10.812–12.417] | -38.5% [-39.2–-8.1%] |
| `lifecycle/restore` | 14.487 [14.308–15.249] | 14.671 [14.166–18.037] | +1.3% [-7.1–+26.1%] |

Calls and List update improved in every pair. Scalar numeric loops also show
consistent directional improvements, with different spreads. Collecting,
transform and Quantity each include a slower pair: their gains are not
established consistently. Fibonacci, which uses no range iteration, is a
regression control; its mixed results and the large Load variation demonstrate
ambient noise. The restore control also has mixed results. Do not attribute
the large grapheme timing change entirely to range construction: it has only
500 outer range items and substantial unaffected Unicode work.

Load is reported separately below in **µs**, using the same median and
minimum–maximum spread of process medians. This change targets iteration, not
Load. No Load improvement is claimed.

| Workload | Before Load µs [spread] | After Load µs [spread] |
|---|---:|---:|
| `core/calls` | 580.0 [429.8–988.4] | 743.7 [411.0–1004.6] |
| `collections/list-update` | 579.3 [514.0–589.3] | 1313.2 [477.9–1336.3] |
| `collections/list-build` | 354.0 [340.3–628.0] | 686.3 [363.4–831.0] |
| `macro/transform` | 674.5 [604.9–681.5] | 595.1 [574.8–1233.9] |
| `numbers/add` | 537.3 [393.2–940.0] | 459.9 [386.5–811.2] |
| `numbers/multiply` | 736.4 [353.4–737.9] | 823.8 [399.7–957.0] |
| `numbers/divide` | 442.5 [437.5–619.4] | 809.4 [493.9–1009.7] |
| `numbers/quantity` | 549.0 [469.4–919.5] | 720.9 [425.5–1008.2] |
| `core/fib` | 912.3 [884.2–921.5] | 503.7 [419.2–952.0] |
| `text/graphemes` | 424.1 [365.0–557.0] | 676.2 [368.6–739.7] |
| `lifecycle/restore` | 522.8 [515.8–1252.9] | 604.9 [540.0–1151.8] |

## Separate profiles

Each profile uses one loaded full-size workload, 20 warm-ups and three seconds
of repeated validated Runs. These whole-process profiles include startup,
Load, warm-up and validation, unlike the earlier issue's Pump-only profile
classification. Inclusive counts overlap, and JIT inlining limits attribution;
percentages cannot be added or converted into an expected speedup. Compressed
raw CPU profiles are in the adjacent `2026-10-15-ts-range-construction-profiles/`
directory, with their SHA-256 hashes in the JSON.

| Profile | Samples | Iterator inclusive | Numeric construction inclusive | Character boundaries inclusive |
|---|---:|---:|---:|---:|
| `before-core-calls` | 2028 | 135 (6.7%) | 509 (25.1%) | 184 (9.1%) |
| `after-core-calls` | 2043 | 83 (4.1%) | 208 (10.2%) | 2 (0.1%) |
| `before-collections-list-update` | 2167 | 172 (7.9%) | 372 (17.2%) | 169 (7.8%) |
| `after-collections-list-update` | 2131 | 93 (4.4%) | 110 (5.2%) | 2 (0.1%) |

Numeric construction still includes arithmetic results, eager canonical text
and frozen wrappers. The profile supports removing the public constructor and
Character segmentation from range items, not eliminating that whole category.
No recognized GC frames were sampled; this does not establish absence of GC.

## Separate heap and GC probes

Twenty measured full-size Runs per workload follow 20 warm-ups. Each starts
after forced full GC; scalar heap/object counters are read before and after
Run, then after another timed forced full GC. The full JSC statistics objects
are discarded immediately so their large bin tables are not retained through
the measured collection. An earlier memory phase retained those tables and
was replaced; `memoryProbeSha256` identifies the corrected, identical probe in
both checkouts. Only the untimed memory branch changed from the timing/CPU
probe identified by `probeSha256`.

JSC's pre-GC counters often report no growth, so `heapGrowth` is not a measure
of allocated bytes or transient churn. The table reports median post-GC heap
delta per Run and forced-GC wall time. These include Group/report retention,
probe overhead and ambient scheduling; they neither isolate the weak cache
nor establish an improvement in allocation rate or GC. Object counts and all
individual measurements are retained in JSON.

| Workload | Post-GC heap delta before/after (bytes) | Forced GC before/after (ms) |
|---|---:|---:|
| `core/fib` | 139595 / 140927 | 1.439 / 1.096 |
| `core/calls` | 65438 / 65461 | 1.697 / 1.152 |
| `numbers/add` | 65217 / 65505 | 1.538 / 1.182 |
| `numbers/multiply` | 66353 / 66032 | 1.619 / 1.156 |
| `numbers/divide` | 65217 / 65537 | 1.602 / 1.206 |
| `numbers/quantity` | 66335 / 65710 | 1.876 / 1.377 |
| `text/graphemes` | 278119 / 278407 | 2.122 / 1.718 |
| `collections/list-build` | 81781 / 81845 | 2.407 / 1.420 |
| `collections/list-update` | 195701 / 195765 | 1.983 / 1.476 |
| `macro/transform` | 97940 / 97909 | 1.635 / 1.458 |
| `lifecycle/restore` | 6570 / -31740 | 2.779 / 2.753 |

## Four-runner comparison

The required command completed successfully with 111 measurements: 30 Zig,
39 TS and 21 each AppleScript and GopherLua. All expected outputs passed and
all overlapping Core Fuel matched. The [full report](2026-10-15-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua.md)
and [JSON](2026-10-15-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua.json)
record every workload, Load, Run, sample count, accounting and explicit skip.

Versions: Zig 0.17.0, native safe build with C Host `-O2`; Bun 1.4.3;
AppleScript 2.8 on macOS 27.0.1; Go 1.27.2 hosting GopherLua v1.1.2.
Zig, AppleScript and Lua have three samples; TS uses mitata's automatic sample
counts. Cells below are **median / minimum**, not a full range: the standard
suite retains only those two statistics and sample count, so its upper-tail
spread cannot be recovered. The paired probe above retains all samples.

Run times, **ms**:

| Workload | Zig median/min | TS median/min | AppleScript median/min | GopherLua median/min |
|---|---:|---:|---:|---:|
| `core/calls` | 0.987 / 0.954 | 2.538 / 2.241 | 0.671 / 0.651 | 0.084 / 0.081 |
| `collections/list-update` | 0.867 / 0.839 | 2.882 / 2.570 | 0.407 / 0.403 | 0.047 / 0.046 |
| `collections/list-build` | 0.332 / 0.260 | 1.413 / 1.293 | 0.237 / 0.237 | 0.072 / 0.072 |
| `macro/transform` | 0.443 / 0.413 | 3.566 / 3.248 | 0.373 / 0.373 | 0.167 / 0.158 |
| `numbers/add` | 0.577 / 0.572 | 2.022 / 1.808 | 0.245 / 0.243 | 0.045 / 0.038 |
| `numbers/multiply` | 0.470 / 0.422 | 1.543 / 1.374 | 0.187 / 0.186 | 0.025 / 0.025 |
| `numbers/divide` | 0.530 / 0.513 | 2.178 / 1.978 | 0.207 / 0.205 | 0.025 / 0.024 |
| `numbers/quantity` | 0.602 / 0.593 | 4.811 / 4.320 | 0.126 / 0.126 | 0.017 / 0.015 |

Load times, **µs**; peers do not time Load:

| Workload | Zig Load median/min | TS Load median/min |
|---|---:|---:|
| `core/calls` | 10.3 / 9.6 | 149.0 / 131.8 |
| `collections/list-update` | 14.4 / 12.4 | 221.1 / 177.0 |
| `collections/list-build` | 7.9 / 7.9 | 139.7 / 122.2 |
| `macro/transform` | 16.3 / 15.5 | 199.2 / 171.6 |
| `numbers/add` | 8.4 / 7.6 | 113.3 / 97.2 |
| `numbers/multiply` | 9.6 / 8.1 | 121.5 / 100.1 |
| `numbers/divide` | 9.8 / 9.4 | 122.8 / 100.9 |
| `numbers/quantity` | 15.5 / 15.0 | 208.0 / 171.4 |

TS remains slower than the three comparison runners on these workloads. This
later TS measurement is also substantially faster than the paired probe's
TS medians, reinforcing the shared-load limitation. It is a separate suite
snapshot, not another before/after pair or evidence of a further code change.

## Semantic verification

- All 5,821 TS tests passed; the focused lifecycle/recovery run passed 300 tests.
- All 429 TS Corpus cases passed against existing expectations. No expectations
  or Spec files changed.
- The new range tests also pass on the unmodified baseline. They pin Fuel and
  logical allocation, and compare reports, Inspect and canonical save bytes
  at every instruction boundary after restoring, including suspension,
  preempted pending cleanup, negative/zero quantum, reversed ranges, both
  34-digit bounds and repeated Runs. Noninteger endpoints still fail.
- Decimal cache tests and internal integer checks preserve exact encoding,
  frozen wrappers, overflow fallback and public input rejection.
- Browser build and smoke test passed. A separate Chromium probe restored a
  signed range after every instruction in two Runs, obtaining `[-2, -1, 0, 1, 2]`
  each time, Fuel 71, logical allocation 544, frozen Values and save format 7.
- The full `bun run check`, lint, formatting and the affected TS Core/benchmark
  typechecks passed.

## Reproduction

Install dependencies in both checkouts, then copy
`bench/ts/src/range-construction.ts` from after into before. Run sequentially:

```sh
python3 bench/ts/range-construction.py <before-checkout> . --before-revision f51ad856e37d802b8865bb2870c3adebc293e7d1 --out bench/results/2026-10-15-ts-range-construction.json
bun run bench --only zig,ts,applescript,gopher-lua --count 3
```

The Python runner writes timing first, then separate memory and CPU evidence.
The current probe includes the scalar-only memory correction described above;
reproduction uses that version for every phase. Performance remains advisory.
