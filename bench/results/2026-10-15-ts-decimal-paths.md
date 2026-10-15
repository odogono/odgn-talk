# TS Decimal paths, 2026-10-15

Evidence for [#944](https://github.com/odogono/odgn-talk/issues/944), comparing
baseline `151f2b8efd00208cd0141ef9b2ddd2d8ff3099c4` with the local candidate
before its implementation commit. This baseline already contains TS charging
specialization (#942) and Character indexing (#940); their earlier gains are
outside this comparison. Language 1.0-rc.3, Cost Model 0, Bun 1.4.3,
Apple M5, macOS 27.0.1, arm64.

The [paired JSON](2026-10-15-ts-decimal-paths.json) retains every sample,
workload source, output, Fuel, logical allocation, source/bundle hashes and
separate heap/GC probes. General rounding and Script expectations are unchanged.

## Implementation

Division first checks whether the coefficient quotient is exact at the ideal
exponent. Otherwise one scaled BigInt division checks for a terminating result
within the available precision and minimum exponent. The candidate has at most
35 digits; exact trailing zeros are removed only toward the ideal exponent,
clamped at zero. A fitting result bypasses general rounding. Nonterminating,
over-precision, underflow and overflow cases retain the original half-even
`result` fallback. Fractional quotients after a 34-digit integer coefficient or
at the minimum exponent go straight to that fallback after the initial check.

`div` returns a fitting integer quotient directly and retains the general
size/overflow path for larger quotients. `mod` aligns once and uses BigInt's
signed remainder. It already fits: when the dividend has the finer exponent,
its coefficient bounds the remainder; otherwise the divisor's coefficient does.
Its exponent is the smaller operand exponent, including for zero. Public Value
construction, logical charging, saved state and error translation are unchanged.
The implementation uses portable BigInt and string operations; no runtime-specific
Core API or mutable Decimal cache is introduced.

## Reproduction

Build the same existing worker against the baseline and candidate checkouts:

```sh
bun build --target=bun bench/ts/src/character-indexing-worker.ts --outfile <before.js>
bun build --target=bun bench/ts/src/character-indexing-worker.ts --outfile <after.js>
python3 bench/ts/decimal-paths.py <before.js> <after.js> \
  --before-revision 151f2b8efd00208cd0141ef9b2ddd2d8ff3099c4 \
  --out bench/results/2026-10-15-ts-decimal-paths.json
python3 bench/ts/decimal-profiles.py <before.js> <after.js> \
  --measurements bench/results/2026-10-15-ts-decimal-paths.json \
  --out bench/results/2026-10-15-ts-decimal-profiles.json
```

The two standalone bundles were built before and after editing `decimal.ts`;
all other Core and worker sources match. Three immediate process pairs alternate
AB, BA, AB for each workload. Each process validates output, warms up five Runs,
then records five samples averaging repeated full-size Runs for at least 50 ms.
Every Run also validates Fuel and logical allocation. Ten fresh Groups and Script
names measure Load separately. Builds and verification suites finish before the
recorded timing. Heap probes and CPU sampling use separate processes afterward.
Measurements are advisory on a shared machine; process ranges below retain the
observed variability and do not establish statistical significance.

The targeted probes perform 1,000 operations, or 100 for the 6,176-place subnormal
and underflow probes. Signed operands, nonterminating thirds, cohort preservation,
34-digit ties, long terminating quotients and over-precision quotients supplement
the existing division, Quantity and indexing workloads. Two probes use Fuel Slice
10, where Pump overhead can dominate arithmetic. Expectations remain fixed.

## Paired Run timings

Cells give the median of three process medians followed by the min–max of those
medians, in ms. Ratios are before/after. All individual samples are in the JSON.

| Workload | Before ms (process range) | After ms (process range) | Ratio |
| --- | ---: | ---: | ---: |
| `core/loop` | 3.938 (3.804–4.041) | 4.086 (3.911–4.140) | 0.96× |
| `core/fib` | 2.618 (2.522–3.710) | 2.647 (2.639–2.730) | 0.99× |
| `numbers/add` | 2.896 (2.677–2.902) | 2.792 (2.786–2.801) | 1.04× |
| `numbers/multiply` | 1.828 (1.802–1.937) | 1.870 (1.826–2.405) | 0.98× |
| `numbers/divide` | 2.445 (2.430–2.517) | 1.961 (1.929–1.969) | 1.25× |
| `numbers/quantity` | 3.869 (3.854–3.895) | 2.802 (2.763–2.814) | 1.38× |
| `text/index` | 2.959 (2.875–3.092) | 2.323 (2.314–2.374) | 1.27× |
| `collections/list-build` | 1.528 (1.447–1.540) | 1.480 (1.456–1.497) | 1.03× |
| `host/pump` | 0.007 (0.007–0.008) | 0.007 (0.006–0.007) | 1.08× |
| `macro/transform` | 2.347 (2.291–2.544) | 2.469 (2.415–2.500) | 0.95× |
| `lifecycle/restore` | 7.924 (7.461–9.250) | 8.289 (7.953–8.322) | 0.96× |
| `probe/terminating` | 1.803 (1.802–1.829) | 1.447 (1.402–1.479) | 1.25× |
| `probe/nonterminating` | 1.915 (1.861–1.948) | 1.725 (1.629–1.772) | 1.11× |
| `probe/signed-div` | 2.110 (2.018–2.121) | 1.418 (1.408–1.454) | 1.49× |
| `probe/signed-mod` | 2.194 (2.149–2.360) | 1.475 (1.443–1.494) | 1.49× |
| `probe/cohort` | 2.332 (2.089–2.363) | 1.587 (1.554–1.624) | 1.47× |
| `probe/precision-boundary` | 2.712 (2.661–2.727) | 2.704 (2.700–2.775) | 1.00× |
| `probe/long-terminating` | 2.657 (2.645–2.657) | 2.426 (2.285–2.438) | 1.10× |
| `probe/over-precision` | 2.669 (2.503–2.817) | 2.714 (2.703–2.782) | 0.98× |
| `probe/subnormal` | 0.357 (0.354–0.375) | 0.404 (0.351–0.411) | 0.88× |
| `probe/underflow` | 0.313 (0.311–0.319) | 0.342 (0.338–0.349) | 0.91× |
| `probe/sliced-terminating` | 3.948 (3.876–5.369) | 3.928 (3.870–4.572) | 1.01× |
| `probe/sliced-signed-mod` | 4.645 (4.450–4.849) | 4.575 (4.417–4.673) | 1.02× |

Division improves by 19.8%, Quantity by 27.6%, and indexing by 21.5% in this
paired capture. These are full Run measurements and do not assign the whole
Quantity or indexing cost to Decimal. The unsliced signed integer probes improve
by about 33%; heavily sliced probes improve by only about 0.5–1.5%.

The nonterminating probe includes both exact integer quotients and rounded thirds;
it improves in aggregate, which does not prove a speedup for each rounded input.
The over-precision probe measures about 1.7% slower, subnormal about 13.3% slower
and underflow about 9.4% slower. The latter two still use general rounding and pay
an extra exactness check; they are not presented as optimized cases. Controls also
vary: loop about 3.6% slower, transform about 5.2% slower and restore about 4.6%
slower. These observations and their spreads limit any general speedup claim.

## Paired Load timings

Load is in µs, using the same process-median convention. This optimization targets
Run; no Load improvement is claimed.

| Workload | Before µs (process range) | After µs (process range) |
| --- | ---: | ---: |
| `core/loop` | 438.417 (429.792–502.917) | 447.667 (427.583–460.228) |
| `core/fib` | 514.583 (503.020–540.104) | 506.874 (494.041–551.396) |
| `numbers/add` | 466.187 (457.917–484.000) | 456.917 (437.021–463.479) |
| `numbers/multiply` | 505.541 (467.729–512.583) | 470.855 (467.583–497.791) |
| `numbers/divide` | 449.771 (434.333–450.333) | 444.355 (429.834–444.750) |
| `numbers/quantity` | 515.563 (495.167–609.501) | 500.647 (494.999–514.063) |
| `text/index` | 477.979 (477.166–488.542) | 506.395 (504.292–507.104) |
| `collections/list-build` | 542.792 (477.667–552.458) | 470.625 (452.521–511.562) |
| `host/pump` | 200.666 (194.875–203.188) | 202.792 (200.750–204.937) |
| `macro/transform` | 580.125 (556.125–596.855) | 635.042 (587.875–911.374) |
| `lifecycle/restore` | 538.417 (513.208–604.541) | 549.938 (526.125–608.688) |
| `probe/terminating` | 427.833 (379.583–439.312) | 382.708 (366.812–395.750) |
| `probe/nonterminating` | 403.792 (389.229–404.562) | 399.334 (397.729–404.438) |
| `probe/signed-div` | 397.229 (383.063–424.291) | 393.812 (383.501–402.792) |
| `probe/signed-mod` | 410.145 (380.896–449.937) | 409.250 (388.417–418.958) |
| `probe/cohort` | 428.313 (398.313–432.625) | 442.438 (401.187–503.625) |
| `probe/precision-boundary` | 444.791 (443.395–461.874) | 455.854 (429.209–495.000) |
| `probe/long-terminating` | 408.145 (407.938–431.291) | 443.313 (406.333–456.626) |
| `probe/over-precision` | 430.958 (423.750–485.937) | 430.813 (422.375–438.146) |
| `probe/subnormal` | 727.959 (682.396–744.375) | 712.834 (707.979–750.978) |
| `probe/underflow` | 807.020 (783.812–810.542) | 780.271 (767.562–840.208) |
| `probe/sliced-terminating` | 402.687 (394.667–432.667) | 412.542 (398.938–413.291) |
| `probe/sliced-signed-mod` | 407.396 (406.312–426.479) | 426.687 (412.646–458.666) |

## Separate CPU and heap/GC evidence

The [CPU summary](2026-10-15-ts-decimal-profiles.json) links eight compressed raw
Bun profiles. Each uses 20 warm-up Runs and three seconds of validated Runs,
with a 1 ms sampling interval. The profiles include startup, Load, warm-up and
validation, whereas the timing table separates Load and Run. Inclusive stack
categories overlap, and JIT inlining limits attribution. No speedup is inferred
from these counts or from the original issue's overlapping sample percentages.

| Workload | Revision | Total samples | Decimal, inclusive | General rounding, inclusive | Exact quotient, inclusive |
| --- | --- | ---: | ---: | ---: | ---: |
| `numbers/divide` | before | 2024 | 732 | 542 | 0 |
| `numbers/divide` | after | 2075 | 502 | 0 | 243 |
| `numbers/quantity` | before | 2114 | 728 | 553 | 0 |
| `numbers/quantity` | after | 2079 | 232 | 0 | 19 |
| `text/index` | before | 2076 | 540 | 389 | 0 |
| `text/index` | after | 2046 | 183 | 0 | 0 |
| `probe/nonterminating` | before | 2050 | 903 | 704 | 0 |
| `probe/nonterminating` | after | 2048 | 731 | 435 | 79 |

Heap probes collect, execute 20 validated Runs, observe the uncollected heap,
then force another collection. The paired JSON retains JSC sizes, selected
object counts, allocator request counters, process memory and final GC duration.
These are single observations per workload/revision, not total allocation or
statistical GC measurements. Automatic collections, JIT activity and snapshot
calls affect these counters. Negative growth is possible after automatic GC.

| Workload | Uncollected JSC growth before → after (bytes) | Object growth before → after | Final forced GC before → after (ms) |
| --- | ---: | ---: | ---: |
| `numbers/divide` | 68,759 → 73,768 | 1,357 → 1,457 | 1.505 → 1.451 |
| `numbers/quantity` | 300,096 → 313,509 | 2,053 → 2,089 | 1.901 → 1.669 |
| `text/index` | 168,664 → 150,517 | 1,586 → 1,574 | 1.918 → 1.536 |
| `probe/nonterminating` | 58,055 → 70,201 | 917 → 909 | 2.098 → 1.942 |
| `probe/subnormal` | 52,139 → 44,109 | 373 → 380 | 2.237 → 2.026 |

No total host-allocation, retained-memory or guaranteed GC-time reduction is
claimed. Fuel and logical allocation are checked independently of these physical
heap observations and match the original Core throughout.


## Entirely nonterminating follow-up

The original `i / 3` probe includes an integer quotient every third iteration.
A [separate three-pair follow-up](2026-10-15-ts-decimal-rounded-thirds.json)
uses `1 / (i - i + 3)` so all 1,000 divisions require rounding. It uses the same
bundles, settings and output/accounting validation, after the four-runner run.
The current driver includes this additional probe; the original capture's
workload array records the 23 workloads measured before it was added.

```sh
python3 bench/ts/decimal-paths.py <before.js> <after.js> \
  --before-revision 151f2b8efd00208cd0141ef9b2ddd2d8ff3099c4 \
  --filter probe/rounded-thirds \
  --out bench/results/2026-10-15-ts-decimal-rounded-thirds.json
```

| Phase | Before (process range) | After (process range) |
| --- | ---: | ---: |
| Run ms | 2.331 (2.255–2.393) | 2.356 (2.336–2.441) |
| Load µs | 430.792 (405.271–447.646) | 430.834 (408.292–435.729) |

The median is 1.1% slower; the three paired ratios range from 0.984 to 1.082 after/before. This does not support a general speedup for rounded division.

## Four-runner comparison

The [full report](2026-10-15-ts-decimal-paths-peers.md) and
[JSON](2026-10-15-ts-decimal-paths-peers.json) come from the unfiltered command:

```sh
bun run bench --only zig,ts,applescript,gopher-lua --count 3
```

All 111 measurements validate existing expectations: 30 Zig, 39 TS and 21 each
for AppleScript and GopherLua. Fuel and logical allocation agree for all 30
TS/Zig overlaps. Zig and peers use three repeats; TS uses mitata's automatic
sample count. Run and Load sample min/median/max/count are retained separately.
The table shows the affected shared workloads; the linked full report retains
the controls and lifecycle cases. Peers have no NorthTalk Load phase.

| Workload | Runner | Run ms, median (min–max; n) | Load µs, median (min–max; n) |
| --- | --- | ---: | ---: |
| `numbers/divide` | zig | 0.337 (0.337–0.368; 3) | 7.302 (7.220–7.362; 3) |
| `numbers/quantity` | zig | 0.298 (0.297–0.299; 3) | 9.237 (9.117–9.369; 3) |
| `text/index` | zig | 0.655 (0.642–0.656; 3) | 8.418 (8.389–8.511; 3) |
| `numbers/divide` | ts | 1.771 (1.613–8.063; 356) | 88.416 (75.458–2912.292; 7011) |
| `numbers/quantity` | ts | 3.227 (2.901–9.121; 200) | 162.625 (135.667–3418.917; 3935) |
| `text/index` | ts | 3.505 (3.169–8.142; 170) | 122.959 (100.791–4349.083; 5041) |
| `numbers/divide` | applescript | 0.240 (0.222–0.257; 3) | — |
| `numbers/quantity` | applescript | 0.146 (0.144–0.152; 3) | — |
| `text/index` | applescript | 1.218 (1.215–1.265; 3) | — |
| `numbers/divide` | gopher-lua | 0.022 (0.022–0.022; 3) | — |
| `numbers/quantity` | gopher-lua | 0.013 (0.013–0.013; 3) | — |
| `text/index` | gopher-lua | 0.138 (0.125–0.141; 3) | — |

These independently scheduled measurements are not paired with the original
TS baseline. TS still trails Zig and the peers on these workloads. Peers have
different number/runtime semantics, and their timings authorize no Spec or
expectation changes. The TS Quantity and indexing medians in this run are also
higher than the paired candidate capture; this is another reason not to mix
measurements from separate runs to infer this patch's gain.

## Verification and handoff

- 5,958 TS Core and Example Host tests pass, including 40 new arithmetic tests
  with four sign combinations per table case, 34-digit ties, long termination,
  cohort/zero handling, subnormals, overflow, division by zero, immutable parts
  and canonical Value Encoding. Existing tests cover exact charging, faults,
  preemption, cancellation, recovery, Save/Restore and reload.
- All 429 existing TS corpus cases pass with their original expected Traces,
  Fuel and logical allocation. No Spec, Data File, corpus expectation or save
  format changes.
- An additional local deterministic comparison of 20,000 valid operand pairs
  checks division, integer quotient and remainder against the original module:
  60,000 results/faults agree, including exponents through -6176 and coefficients
  at the precision limits. This exploratory check supplements the committed
  regression tests; its temporary harness is not part of the benchmark artifacts.
- Browser package build and actual browser smoke pass, including exact division,
  signed integer/remainder arithmetic and the half-even fallback.
- Nine benchmark summary/measurement tests pass. Workspace typechecking, lint,
  formatting, Spec/generated-table checks and documentation links pass.
- Paired workloads, the entirely rounded follow-up, heap probes, profiles and
  the four-runner comparison retain existing outputs and accounting. Slice-10
  division and remainder probes also match exact Fuel/allocation across revisions.

The required base in #944 is satisfied: `151f2b8e` contains `f51ad856` plus the
newer landed changes. Normative Number rules remain chapter 3's arithmetic and
chapter 8's accounting. The local implementation satisfies the optimization,
semantic verification and measurement scope; review and merge remain. No first
blessing or expectation approval is needed. Reconcile #944's implementation
handoff when this work lands; do not mark it implemented in a merged PR yet.

## Integration after #941 and #943

Rebased onto `f0ec960a` after Unit metadata reuse (#941, PR #952) and integer-range
construction (#943, PR #949) landed. The only rebase conflict was adjacent
implementation-guide prose; both descriptions are retained. Decimal arithmetic
is unchanged from the measured candidate. The combined branch passes 5,982 TS
Core/Example Host tests, all 429 corpus cases and workspace typechecking.
Historical timing and profile artifacts remain pinned to `151f2b8e` and their
recorded source/bundle hashes. They exclude the later Unit and range changes
and do not establish their combined performance.
