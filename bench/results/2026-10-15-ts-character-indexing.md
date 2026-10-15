# TS chunk-read measurements, 2026-10-15

Evidence for [#940](https://github.com/odogono/odgn-talk/issues/940), comparing
required base `f51ad856e37d802b8865bb2870c3adebc293e7d1` with the TS chunk-read
candidate, captured before its implementation commit. The
[raw paired measurements](2026-10-15-ts-character-indexing.json) retain all
samples, workload sources and hashes, bundle hashes, output/accounting checks,
and separate heap/GC probes. Language 1.0-rc.3, Cost Model 0, Bun 1.4.3,
Apple M5, macOS 27.0.1, arm64.

`text/index` decreases from 6.105 to 3.668 ms: 1.66×, or 39.9% less Run time.
Its result remains `125`, with 26,640 Fuel and 51,072 logical bytes. The fixed
Character probes improve at every tested length and index direction. Several
control workloads measure slower; their results and a targeted recheck are
recorded below. Other CPU-intensive jobs were active on this shared machine,
so the timings are advisory.

## Implementation

Character reads slice the source string using one pinned Unicode boundary
array, instead of segmenting three times and materializing Character strings
and chunk objects.
ASCII without CRLF uses UTF-16 offsets directly after a whole-string check.
Full-string validation ensures that a non-ASCII suffix cannot silently extend
the selected ASCII Character. Unicode and CRLF retain the general segmenter.
Code-point reads use one scalar array without chunk objects. Word, line and
item reads reuse one segmented array for span construction, input counting
and result selection; their Unicode probes below support retaining this
extension of the shared path.

The result still goes through the NFC Text constructor. Index resolution,
`scanned`, charging and instruction preemption are unchanged. Public Values,
save encoding and Unicode tables gain no fields or caches. ASCII validation
remains O(n), and Unicode reads retain full segmentation for positive and
negative indexes. Word, line and item reads still materialize their spans.

## Method and reproduction

Each workload has three immediate before/after process pairs, in AB, BA, AB
order. Both standalone Bun bundles contain the same worker; the baseline bundle
substitutes only `operations.ts` from the required base. Every other Core source
matches that base. Copy the current worker into the baseline checkout, then
build the worker against each revision with the same harness:

```sh
bun build --target=bun bench/ts/src/character-indexing-worker.ts --outfile <before.js>
bun build --target=bun bench/ts/src/character-indexing-worker.ts --outfile <after.js>
python3 bench/ts/character-indexing.py <before.js> <after.js> \
  --before-revision f51ad856e37d802b8865bb2870c3adebc293e7d1 \
  --out <results.json>
```

Each process validates the expected result, warms up five full-size Runs, then
records five samples averaging repeated Runs for at least 50 ms each. Slow
Runs exceed that window. Every Run checks output, Fuel and logical allocation.
Load is separate: ten fresh Script names in fresh Groups, excluding Run time.
Builds, profiles and test suites are outside the recorded paired measurements.

The fixed-index probes perform 1,000 reads and return the selected Character,
with no modulo, equality or summation. Lengths are 16, 256 and 4,096 Characters;
`early` selects 8, `late` the final positive index and `last` -1. Unicode probes
read a ZWJ family (or its first scalar) from NFC/combining/emoji/flag text. Raw
sources pin the exact workloads, including CRLF for the line probe.

## Paired Run timings

Cells give the median of the three process medians, followed by their min–max
range, in ms. All individual sample values remain in the raw JSON. Ratios are
before/after; results below one are measured slowdowns.

| Workload | Before ms (process range) | After ms (process range) | Ratio |
| --- | ---: | ---: | ---: |
| `core/loop` | 4.387 (4.283–4.840) | 4.695 (4.413–5.276) | 0.93× |
| `core/fib` | 3.270 (2.969–3.879) | 3.183 (2.977–3.644) | 1.03× |
| `text/build` | 1.115 (1.092–1.255) | 1.087 (1.080–1.626) | 1.03× |
| `text/iterate` | 3.857 (3.214–4.715) | 3.219 (3.200–4.660) | 1.20× |
| `text/index` | 6.105 (5.764–6.660) | 3.668 (3.602–4.062) | 1.66× |
| `text/patterns` | 7.031 (6.902–7.769) | 7.898 (7.805–8.101) | 0.89× |
| `text/graphemes` | 6.347 (6.145–7.639) | 7.552 (6.508–8.478) | 0.84× |
| `collections/list-build` | 2.382 (1.894–2.385) | 2.345 (2.314–2.758) | 1.02× |
| `host/pump` | 0.014 (0.011–0.019) | 0.010 (0.009–0.013) | 1.40× |
| `macro/transform` | 3.197 (2.886–3.885) | 3.579 (2.999–4.737) | 0.89× |
| `macro/report` | 2.301 (2.031–2.639) | 2.275 (2.048–2.813) | 1.01× |
| `lifecycle/restore` | 10.976 (9.564–11.795) | 11.966 (10.890–12.035) | 0.92× |
| `probe/ascii-16-early` | 4.253 (4.212–4.370) | 1.046 (0.900–1.197) | 4.07× |
| `probe/ascii-16-late` | 3.678 (3.351–4.556) | 1.245 (1.186–1.341) | 2.95× |
| `probe/ascii-16-last` | 4.242 (3.796–4.455) | 1.559 (1.261–1.915) | 2.72× |
| `probe/ascii-256-early` | 34.487 (32.976–37.088) | 1.234 (1.043–1.637) | 27.96× |
| `probe/ascii-256-late` | 32.035 (31.083–35.512) | 1.190 (1.047–1.291) | 26.93× |
| `probe/ascii-256-last` | 33.771 (32.179–39.097) | 1.617 (1.566–1.731) | 20.89× |
| `probe/ascii-4096-early` | 472.527 (468.510–576.949) | 3.015 (2.826–3.487) | 156.73× |
| `probe/ascii-4096-late` | 467.163 (465.643–480.646) | 3.029 (2.970–3.052) | 154.25× |
| `probe/ascii-4096-last` | 510.406 (485.285–553.949) | 2.943 (2.864–3.352) | 173.43× |
| `probe/unicode-character` | 3.546 (3.350–5.238) | 2.042 (1.911–2.920) | 1.74× |
| `probe/unicode-word` | 4.215 (4.039–5.335) | 2.447 (2.383–3.626) | 1.72× |
| `probe/unicode-line` | 4.514 (4.358–4.645) | 2.692 (2.415–2.943) | 1.68× |
| `probe/unicode-item` | 4.424 (4.154–5.060) | 2.562 (2.443–2.897) | 1.73× |
| `probe/unicode-code point` | 1.771 (1.740–2.671) | 1.317 (1.175–1.491) | 1.34× |

## Paired Load timings

Load is reported separately in µs, with the same median-of-process-medians and
process-median min–max convention. This change targets Run; no Load speedup is
claimed. Probe Load samples, including their longer literal inputs, are in JSON.

| Workload | Before µs (process range) | After µs (process range) |
| --- | ---: | ---: |
| `core/loop` | 510.81 (476.73–523.10) | 498.65 (463.52–510.81) |
| `core/fib` | 528.65 (516.96–548.96) | 540.75 (535.02–625.88) |
| `text/build` | 458.85 (436.35–464.19) | 449.69 (449.06–469.54) |
| `text/iterate` | 512.12 (501.23–541.38) | 527.92 (486.96–555.27) |
| `text/index` | 567.23 (524.94–739.60) | 554.85 (546.42–691.75) |
| `text/patterns` | 561.50 (520.52–647.94) | 584.69 (562.06–593.87) |
| `text/graphemes` | 524.62 (521.44–545.04) | 869.00 (545.77–1044.75) |
| `collections/list-build` | 541.83 (516.12–545.50) | 588.48 (541.12–731.71) |
| `host/pump` | 392.31 (209.50–568.54) | 217.56 (210.77–374.54) |
| `macro/transform` | 685.42 (668.81–731.44) | 808.73 (709.94–934.48) |
| `macro/report` | 1045.65 (578.08–1078.35) | 596.87 (563.40–627.56) |
| `lifecycle/restore` | 538.02 (529.17–618.52) | 688.40 (604.23–1361.56) |

## CPU and heap/GC evidence

[Profile summaries](2026-10-15-ts-character-indexing-profiles.json) link four
compressed raw Bun profiles. These use 20 warm-up Runs and three seconds of
repeated validated full-size Runs at a 1 ms sampling interval, in separate
processes after timing. Pump attribution includes warm-up and validation;
categories overlap and JIT inlining limits attribution. Sample percentages
are not used to derive the timing speedups.

| Profile | Pump samples | Character boundaries (inclusive) | Chunk spans (inclusive) |
| --- | ---: | ---: | ---: |
| before `text/index` | 2106 | 758 | 410 |
| after `text/index` | 2008 | 169 | 0 |
| before `probe/unicode-character` | 2048 | 1086 | 483 |
| after `probe/unicode-character` | 2036 | 721 | 0 |

Heap probes also run separately: collect, run the same loaded Script 20 times,
observe the uncollected heap, then force another collection. The JSON retains
JSC heap sizes, selected object counts, aggregate allocator counters, process
memory and the final collection duration. This is one probe per workload and
revision, rather than a statistical allocation or GC benchmark. Heap snapshot
calls and JIT/collector work affect process allocator counters; those counters
are not per-Value allocation totals.

| Workload | Uncollected JSC heap growth before → after (bytes) | Object growth before → after | Final forced GC before → after (ms) |
| --- | ---: | ---: | ---: |
| `text/index` | 278,221 → 231,767 | 3,662 → 2,104 | 1.651 → 1.759 |
| `probe/ascii-4096-early` | 4,558,956 → 37,518 | 56,895 → 570 | 2.080 → 1.880 |
| `probe/unicode-character` | 217,910 → 166,100 | 1,794 → 993 | 2.349 → 2.953 |

The long ASCII probe shows much less temporary heap growth. Small-probe GC
observations vary in both directions. `text/index` retains exactly 35,466 JSC
objects after final collection on both sides. None of these observations is a
claim about total allocated bytes, RSS, or a guaranteed GC-time improvement.


## Control recheck

The [targeted recheck](2026-10-15-ts-character-indexing-recheck.json) repeats the
five slower controls after the four-runner comparison, with the same bundle
hashes, three immediate pairs, five warm-up Runs and five samples per process.
No implementation changes occurred between these measurements. Cells again
show ms medians and the range of process medians.

| Workload | Before ms (process range) | After ms (process range) | Ratio |
| --- | ---: | ---: | ---: |
| `core/loop` | 4.347 (4.085–4.442) | 4.171 (4.169–4.189) | 1.04× |
| `text/patterns` | 6.406 (6.335–6.572) | 6.298 (6.189–6.447) | 1.02× |
| `text/graphemes` | 5.431 (5.338–5.490) | 5.458 (5.291–5.492) | 1.00× |
| `macro/transform` | 2.541 (2.508–2.696) | 2.649 (2.524–2.676) | 0.96× |
| `lifecycle/restore` | 8.185 (7.805–8.396) | 8.547 (7.657–18.690) | 0.96× |

The initial 12% patterns and 19% graphemes slowdowns are not reproduced at that
magnitude: their recheck medians are about 2% faster and 0.5% slower respectively.
`macro/transform` and `lifecycle/restore` still measure about 4% slower. Restore
has an 18.690 ms after-process outlier. These are reported observations on an
active shared machine, not proof that all control differences are noise or that
every workload improves. Core source changes remain confined to text chunk reads.

## Four-runner comparison

The [full four-runner report](2026-10-15-ts-character-indexing-peers.md)
and [raw JSON](2026-10-15-ts-character-indexing-peers.json)
come from the requested unfiltered command:

```sh
bun run bench --only zig,ts,applescript,gopher-lua --count 3
```

All 111 measurements validate their existing outputs. Every overlapping TS/Zig
workload has identical Fuel and logical allocation. Zig, AppleScript and Lua
use three samples; TS uses mitata's automatic sample count. The report stores
maximum samples as well as minimum/median, including in the AppleScript runner;
older reports without a maximum remain readable. Load stays separate from Run.
The selected text results below give medians, sample min–max and sample counts.
Peers have no measured NorthTalk Load.

| Workload | Runner | Run ms, median (min–max; n) | Load µs, median (min–max; n) |
| --- | --- | ---: | ---: |
| `text/build` | zig | 0.439 (0.438–0.441; 3) | 5.939 (5.917–5.991; 3) |
| `text/iterate` | zig | 0.645 (0.607–0.654; 3) | 7.091 (7.087–7.333; 3) |
| `text/index` | zig | 0.691 (0.690–0.692; 3) | 8.034 (7.949–8.037; 3) |
| `text/patterns` | zig | 0.608 (0.607–0.611; 3) | 7.513 (7.503–7.514; 3) |
| `text/graphemes` | zig | 1.152 (1.146–1.168; 3) | 7.905 (7.835–8.281; 3) |
| `text/build` | ts | 1.093 (1.045–5.619; 608) | 95.834 (83.542–3094.791; 6742) |
| `text/iterate` | ts | 3.495 (3.255–6.208; 186) | 112.250 (99.709–3577.125; 5773) |
| `text/index` | ts | 3.971 (3.780–6.196; 163) | 131.916 (114.250–3950.125; 4928) |
| `text/patterns` | ts | 6.225 (5.567–8.790; 103) | 129.583 (107.208–4293.125; 5156) |
| `text/graphemes` | ts | 5.861 (5.415–9.149; 109) | 119.479 (90.125–4456.541; 5604) |
| `text/build` | applescript | 0.381 (0.378–0.388; 3) | — |
| `text/iterate` | applescript | 3.631 (3.607–3.633; 3) | — |
| `text/index` | applescript | 0.960 (0.948–1.031; 3) | — |
| `text/patterns` | applescript | 16.694 (16.517–16.821; 3) | — |
| `text/build` | gopher-lua | 0.071 (0.070–0.075; 3) | — |
| `text/iterate` | gopher-lua | 0.179 (0.178–0.180; 3) | — |
| `text/index` | gopher-lua | 0.125 (0.119–0.127; 3) | — |
| `text/patterns` | gopher-lua | 0.280 (0.275–0.301; 3) | — |

TS indexing remains about 5.75× slower than Zig, 4.14× slower than AppleScript
and 31.8× slower than GopherLua in this separate comparison. Peer-language
number, string and runtime semantics differ; this comparison does not authorize
changes to NorthTalk's Spec, Cost Model or expectations.

## Verification and handoff

- TS Core and Example Host suite: 5,815 tests pass, including the pinned Unicode
  normalization/grapheme vectors, immutable Values, limits, cancellation,
  preemption, Save/Restore, reload and recovery lifecycle tests.
- All 429 existing TS corpus cases pass with their original expected Traces and
  accounting. No corpus or Spec expectation file changes.
- The new direct operation tests check results and exact `scanned` counts over
  ASCII controls, CRLF, emoji/ZWJ, flags, combining/Indic/Hangul text, mixed-sign,
  zero, reversed, clipped and large indexes, delimiters and empty chunks.
- Benchmark summary/measurement tests: nine pass. Browser bundle and smoke page
  pass, including ASCII, CRLF and Unicode chunk reads with platform Unicode
  normalization/segmentation disabled.
- Repository lint, formatting, Spec/generated-data/documentation checks and
  workspace typechecking pass.

Required base and Spec sections remain those in #940: current `main` containing
`f51ad856`, chapter 4 Chunk Expressions and chapter 8 charging. The measurements
were captured against `f51ad856` before committing the candidate; source and
bundle hashes identify the measured implementation. Later Zig changes and TS Cost Model specialization (#942) on `main`
are outside these timing comparisons; the measurements isolate the chunk-read
change against its recorded base. This evidence records the proposed
implementation; review and merge remain. No first blessing, Spec change or
expectation approval is needed.
The implementation files are `impl/ts/src/operations.ts`, its Core guide,
`impl/ts/tests/chunk-reads.test.ts`, `impl/ts/tests/browser-smoke.html` and
`changelog/unreleased/ts-chunk-reads.md`. Supporting benchmark changes are the
paired driver/worker, report range summaries/tests, AppleScript measurement,
ESLint command-host entry, Benchmark guide, and the dated result files linked
above.

## Integration after #942

Rebased onto `37d296f2` after TS Cost Model specialization (#942) landed. The
shared maximum-sample statistics implementation now comes from `main`. The
chunk-read four-runner records were renamed to
`2026-10-15-ts-character-indexing-peers.{md,json}`, preserving both this scope's
measurements and #942's original dated reports byte-for-byte.

The combined branch passes 5,918 TS Core/Example Host tests, all 429 original
corpus cases, nine benchmark summary/measurement tests, and workspace
typechecks. Historical timings above remain pinned to their recorded baseline;
they do not attribute the accounting specialization's performance to this change.
