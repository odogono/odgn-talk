# Zig Text concatenation measurements — 2026-10-15

Evidence for [#957](https://github.com/odogono/odgn-talk/issues/957). Retain the
narrow trusted-Text and ASCII-metadata change: full-size `text/build` improves
from 0.4245 to 0.1014 ms
(4.19×), with the same result `1500`,
28,928 Fuel and 383,838 logical bytes. `macro/report` improves by
2.52×. Physical allocation requests, frees,
live peak delta, held memory, Group peak and size histograms agree exactly on
all 38 measured workloads/probes. This change removes repeated scanning;
it does not reduce the bytes copied into growing Text buffers.

## Implementation and boundaries

Text-to-Text `concat` uses immutable operands that already passed UTF-8/NFC
validation. Untrusted `text` and byte-slice `concatText` inputs still reject
invalid UTF-8. Unicode joins normalize the entire joined result using the
existing NFC implementation, including combining-mark reordering and Hangul.
Non-Text operand conversion retains the existing validated path.

ASCII Text stores its Character count in the existing `Value.measure` field,
with an ASCII flag in header padding. A join combines those counts with an
exact correction when CR meets LF. Scalar counts use byte length, separately
from Character counts. Unicode Character counts still use full segmentation;
they are never added across arbitrary joins. Character/scanned charges and
logical sizes keep their original meanings. Metadata has no separate storage,
retains no other Value, and is reconstructed from Text bytes on Restore.
Results remain owned contiguous byte slices; old Text Values remain intact.

## Method and reproduction

Baseline runtime: `0aed90d300069ae754ba7dab010f3ef4d92141e7`, the issue's
required base. After: the #957 working tree on that same revision. The
[raw pairs](2026-10-15-zig-text-growth.json) identify both binaries, runtime
sources, original baseline sources, the tracked runtime/Host diff, manifest
and measurement script by SHA-256. They do not claim an after commit has landed.
The common C Host raises only its untimed allocation histogram capacity from
8,192 to 32,768 distinct sizes so the 8,192-append probe can complete. Both
binaries use that same Host source.

Apple M5, macOS 27.0.1 arm64, Zig 0.17.0 native `safe`, Apple clang 21 C Host
`-O2`, language 1.0-rc.3, Cost Model 0. Each process validates its output and
accounting, then takes five samples averaging complete checked Runs over at
least 50 ms each. A slow Run can exceed that window. Runs reuse a loaded Script;
Load is timed separately. Three pairs alternate process order AB/BA/AB.
Every timed iteration must reproduce the checked Run's Fuel and logical
allocation, and before/after must agree.

All timings finish before counting-allocator probes and CPU sampling. One
untimed allocation probe per binary/workload is shared across the three pair
records. No builds, tests or other timings from this thread overlapped a timed
phase. Other work was active on this shared desktop; absolute times and small
ratios remain advisory. Tables report medians of process medians and their
minimum–maximum spread, not confidence intervals.

```sh
# Build the baseline and changed native libraries separately with zig build.
# Link each to the same bench/zig/host.c as bench/ts/src/measure-zig.ts does.
python3 bench/zig/text-growth.py <before-host> <after-host> \
  --before-revision 0aed90d300069ae754ba7dab010f3ef4d92141e7 \
  --pairs 3 --count 5 --profiles <profile-directory> --out <pairs.json>
python3 bench/zig/text-growth.py <before-host> <after-host> \
  --before-revision 0aed90d300069ae754ba7dab010f3ef4d92141e7 \
  --pairs 9 --count 1 --filter text/ --filter core/fib \
  --filter host/pump --filter macro/game-tick --out <recheck.json>
```

The main run covers all 26 supported manifest scripts plus 12 growth/length
probes: 114 paired comparisons. The four extra Fibonacci Fuel Slice variants
are not repeated here. Growth probes append either ASCII `abc` or the
31-byte, four-Character unit `éq́👨‍👩‍👧🇬🇧`, for 32, 256 and 2,048 joins;
ASCII also reaches 8,192 joins. Length probes perform 128 joins with chunks of
1/16/256 ASCII bytes or 1/16 Unicode units. Unicode units have stable boundaries
between copies. Probes return exact Character length and include loop/VM/Host
costs, so their times are not isolated concat-instruction costs.

## Paired Run times

All times are milliseconds. The range columns span the three process medians.

| Workload | Before | After | Ratio | Before range | After range |
| --- | ---: | ---: | ---: | ---: | ---: |
| `core/loop` | 0.8781 | 0.8653 | 1.01× | 0.8686–0.9064 | 0.8540–0.8793 |
| `core/fib` | 0.5926 | 0.5960 | 0.99× | 0.5920–0.6263 | 0.5894–0.6242 |
| `core/calls` | 0.6012 | 0.5935 | 1.01× | 0.5963–0.6291 | 0.5731–0.6003 |
| `core/lambdas` | 0.7874 | 0.7806 | 1.01× | 0.7797–0.8176 | 0.7620–0.7939 |
| `numbers/add` | 0.4445 | 0.4365 | 1.02× | 0.4395–0.4643 | 0.4200–0.4476 |
| `numbers/multiply` | 0.2826 | 0.2809 | 1.01× | 0.2755–0.2897 | 0.2743–0.2876 |
| `numbers/divide` | 0.3167 | 0.3161 | 1.00× | 0.3162–0.3182 | 0.3079–0.3172 |
| `numbers/quantity` | 0.2871 | 0.2861 | 1.00× | 0.2796–0.2927 | 0.2784–0.2885 |
| `text/build` | 0.4245 | 0.1014 | 4.19× | 0.4216–0.4249 | 0.0963–0.1031 |
| `text/iterate` | 0.5420 | 0.4963 | 1.09× | 0.5181–0.5452 | 0.4872–0.5094 |
| `text/index` | 0.6187 | 0.6351 | 0.97× | 0.6026–0.6252 | 0.6062–0.7298 |
| `text/patterns` | 0.5731 | 0.5777 | 0.99× | 0.5540–0.5781 | 0.5550–0.5966 |
| `text/graphemes` | 1.0228 | 1.0777 | 0.95× | 1.0204–1.0466 | 1.0292–1.0795 |
| `collections/list-build` | 0.2059 | 0.1985 | 1.04× | 0.1976–0.2080 | 0.1910–0.3194 |
| `collections/list-append` | 0.9007 | 0.8835 | 1.02× | 0.8707–0.9523 | 0.8641–0.8946 |
| `collections/map-build` | 0.9081 | 0.9093 | 1.00× | 0.8852–0.9196 | 0.8921–0.9126 |
| `collections/list-update` | 0.5308 | 0.5217 | 1.02× | 0.5098–0.5337 | 0.5135–0.5348 |
| `collections/map-update` | 0.2081 | 0.2047 | 1.02× | 0.2016–0.2092 | 0.1996–0.2064 |
| `collections/iterate` | 1.4561 | 1.4104 | 1.03× | 1.4298–1.5192 | 1.3799–1.4522 |
| `host/pump` | 0.0017 | 0.0018 | 0.94× | 0.0016–0.0020 | 0.0018–0.0018 |
| `macro/transform` | 0.2806 | 0.2774 | 1.01× | 0.2790–0.2860 | 0.2765–0.2780 |
| `macro/report` | 1.2109 | 0.4808 | 2.52× | 1.2026–1.2336 | 0.4808–0.4893 |
| `macro/game-tick` | 1.2692 | 1.2914 | 0.98× | 1.2585–1.3124 | 1.2713–1.3361 |
| `messaging/suspend` | 2.9690 | 2.8006 | 1.06× | 2.8133–3.4851 | 2.7641–3.0844 |
| `lifecycle/load-small` | 0.0017 | 0.0017 | 1.04× | 0.0016–0.0017 | 0.0016–0.0019 |
| `lifecycle/load-large` | 0.1427 | 0.1354 | 1.05× | 0.1412–0.1459 | 0.1321–0.1379 |
| `growth/ascii-32` | 0.0118 | 0.0085 | 1.39× | 0.0116–0.0119 | 0.0085–0.0149 |
| `growth/ascii-256` | 0.1458 | 0.0505 | 2.89× | 0.1455–0.1521 | 0.0498–0.0529 |
| `growth/ascii-2048` | 5.2474 | 0.5224 | 10.05× | 5.2348–5.2490 | 0.5057–0.5303 |
| `growth/unicode-32` | 0.1699 | 0.1514 | 1.12× | 0.1666–0.1705 | 0.1509–0.1518 |
| `growth/unicode-256` | 9.5255 | 8.7670 | 1.09× | 9.4237–9.6245 | 8.6265–8.7965 |
| `growth/unicode-2048` | 662.0030 | 589.0920 | 1.12× | 630.5840–689.0750 | 575.6220–618.0630 |
| `growth/ascii-8192` | 81.5730 | 3.7941 | 21.50× | 75.9870–84.0630 | 3.7382–3.9426 |
| `length/ascii-1` | 0.0363 | 0.0261 | 1.39× | 0.0348–0.0386 | 0.0249–0.0268 |
| `length/ascii-16` | 0.1702 | 0.0281 | 6.06× | 0.1645–0.1830 | 0.0274–0.0298 |
| `length/ascii-256` | 2.2175 | 0.0793 | 27.97× | 2.2121–2.2582 | 0.0768–0.0825 |
| `length/unicode-1` | 2.4931 | 2.2687 | 1.10× | 2.4512–2.4959 | 2.1834–2.3471 |
| `length/unicode-16` | 41.5290 | 37.5780 | 1.11× | 40.3810–42.3400 | 37.4105–39.0560 |

## Regression recheck

The [nine closer pairs](2026-10-15-zig-text-growth-recheck.json) use the same
binaries and one calibrated sample per process, covering eight focused scripts
72 times. They test the main run's apparent 2.7% indexing, 5.4% Unicode-grapheme
and 6.6% tiny-Pump slowdowns. Those larger differences do not persist. Small
residual differences are retained below; no uniform speedup is claimed.

| Workload | Median paired ratio | After faster, out of 9 |
| --- | ---: | ---: |
| `core/fib` | 1.0125× | 7 |
| `text/build` | 4.3529× | 9 |
| `text/iterate` | 1.0644× | 9 |
| `text/index` | 1.0015× | 5 |
| `text/patterns` | 1.0032× | 6 |
| `text/graphemes` | 0.9975× | 2 |
| `host/pump` | 1.0070× | 6 |
| `macro/game-tick` | 0.9954× | 3 |

Unicode grapheme iteration retains a 0.25% median slowdown in the closer pairs,
and game-tick 0.46%; these measurements do not establish a material regression.
Text indexing is effectively unchanged, while ASCII iteration improves about
6.4% and construction about 4.35× in the closer pairs. Broader scalar scripts
in the main pairs stay close to baseline. The raw samples retain the desktop's
larger outliers rather than excluding them.

## Physical allocation and copying

These are Group parent-allocator requests during one checked Run, excluding
Load and process-owned Host Values. They are requested bytes, not resident
memory. Group peak includes Load; live peak delta is relative to Run start.
Both implementations have exactly the following values; every recorded
allocation counter and size histogram agrees, including workloads omitted here.
The counting allocator is separate from the default timing allocator.

| Workload | Calls, either binary | Requested bytes | Live peak delta | Group peak |
| --- | ---: | ---: | ---: | ---: |
| `text/build` | 526 | 387,568 | 10,014 | 24,347 |
| `text/iterate` | 1,848 | 41,198 | 17,992 | 30,650 |
| `text/index` | 1,028 | 13,549 | 10,264 | 34,777 |
| `macro/report` | 2,030 | 1,344,573 | 14,766 | 31,605 |
| `growth/ascii-256` | 280 | 109,985 | 9,494 | 20,833 |
| `growth/ascii-2048` | 2,072 | 6,305,826 | 17,540 | 22,689 |
| `growth/ascii-8192` | 8,216 | 100,686,883 | 54,404 | 59,553 |
| `growth/unicode-256` | 2,856 | 12,003,482 | 60,256 | 65,629 |
| `growth/unicode-2048` | 32,839 | 787,692,562 | 433,216 | 438,589 |
| `length/ascii-256` | 152 | 2,124,835 | 70,535 | 78,399 |
| `length/unicode-16` | 2,081 | 49,608,042 | 432,751 | 442,761 |

Explicit result-byte writes below are calculated from the probe inputs, not
hardware counters. ASCII writes each complete growing prefix once into its
joined buffer. Unicode writes that join and rebuilds the same bytes through
NFC. Counts exclude normalization Entry arrays, allocator poisoning/movement,
Value nodes, scratch and Host output. They are the same before/after and grow
quadratically with append count. Full-size `text/build` copies 375,750 bytes
into joined buffers on either side.

| Probe | Joined-buffer bytes | Explicit Text result-byte writes, either binary |
| --- | ---: | ---: |
| `growth/ascii-256` | 98,688 | 98,688 |
| `growth/ascii-2048` | 6,294,528 | 6,294,528 |
| `growth/ascii-8192` | 100,675,584 | 100,675,584 |
| `growth/unicode-256` | 1,019,776 | 2,039,552 |
| `growth/unicode-2048` | 65,043,456 | 130,086,912 |
| `length/unicode-16` | 4,094,976 | 8,189,952 |

## Separate CPU captures and representation decision

The six [compressed raw call trees](2026-10-15-zig-text-growth-profiles/) each
sample two seconds at 1 ms intervals after the timing/allocation phases.
The JSON's `profileScriptSha256` records the separate profile-only capture pass;
`measurementScriptSha256` identifies the earlier timing pass. Both passes check
the same binary and runtime source hashes. Categories are inclusive within
`talk_pump`, overlap, and are limited by inlining. They are not projected speedups.

| Binary / workload | Pump samples | Concat | UTF-8 validation | NFC | Charging | memcpy/memmove |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| before / `text/build` | 1529 | 761 | 361 | 0 | 385 | 19 |
| before / `growth/unicode-256` | 1512 | 1430 | 146 | 1275 | 65 | 3 |
| before / `growth/ascii-8192` | 1531 | 956 | 487 | 0 | 531 | 13 |
| after / `text/build` | 1499 | 220 | 0 | 0 | 120 | 73 |
| after / `growth/unicode-256` | 1525 | 1453 | 0 | 1442 | 55 | 8 |
| after / `growth/ascii-8192` | 1391 | 623 | 0 | 0 | 39 | 298 |

Validation disappears from these internal joins. At 8,192 ASCII appends,
identified copy frames account for 298/1,391 after Pump samples (21.4%); this
does not establish copying as the dominant whole-Run cost. Unicode normalization
accounts for 1,442/1,525 after samples (94.6%) on the 256-append Unicode probe.
These results support retaining the narrow metadata path before a rope/builder
redesign. Large growth still has quadratic byte traffic, and Unicode still
pays for whole-result normalization; neither limitation is claimed solved.

## Fresh limited four-way comparison

The [full report](2026-10-15-zig-text-growth-peers.md) and
[raw JSON](2026-10-15-zig-text-growth-peers.json) come from exactly:

```sh
bun run bench --only zig,ts,applescript,gopher-lua --count 3
```

All 111 records complete: 30 native Zig variants, 39 TS variants and 21 each
on AppleScript and GopherLua. Zig and TS agree on both Fuel and logical
allocation for all 30 overlapping variants. The JSON explicitly identifies the
#957 working tree on the base commit and records its runtime source hashes.
TS uses mitata automatic sampling; Zig and peers use three repeats. Load and
Run are distinct. A dash means the peer runner does not measure Load.

Full-size `text/build`, milliseconds:

| Runner | Load median | Run median | Run min–max |
| --- | ---: | ---: | ---: |
| zig | 0.0059 | 0.0964 | 0.0952–0.0979 |
| ts | 0.0790 | 0.7438 | 0.6873–2.0586 |
| applescript | — | 0.3640 | 0.3632–0.3661 |
| gopher-lua | — | 0.1046 | 0.1042–0.1075 |

In this capture Zig Text build is 3.77× faster than AppleScript, closing the
issue's small earlier gap. GopherLua takes 1.08× Zig's Run time. This is a fresh comparison, not a controlled before/after peer
speedup. Peers use native numbers and idiomatic ports; ratios are workload
targets rather than instruction-cost equivalence. The full report retains
scalar workloads and their remaining peer gaps. Other-language and WASM
performance runners were not started; WASI was used only for correctness.

## Correctness gates

- `bun install --frozen-lockfile`, `bun run unicode:check`: pinned Unicode 18 data
  and generated tables verified.
- `zig build install test --summary all`: 246/246 Zig tests and the C Host tests
  pass, including the pinned normalization and grapheme conformance data.
- `zig build corpus` and `zig build corpus -- --defer-crossings`: all 429 cases
  pass in both invocations; Trace replay also saves/restores between Pumps.
- Focused tests cover empty and mixed joins, all ASCII control bytes, CRLF
  split/association, combining-mark composition/reordering, Hangul LV/LVT,
  emoji ZWJ, flags, Indic and Prepend graphemes, retained old Values and refusal
  at every allocation. Independent decoding/segmentation checks exact charges.
- The new machine test saves/restores at every Fuel-Slice boundary, compares
  saved bytes and subsequent Traces, and checks retained/concatenated Text,
  length and positive/negative Character reads structurally.
- `zig build -Dtarget=wasm32-wasi`, `uv run tools/wasi/zig.py <module>` and
  `uv run tools/wasi/check.py <module>` pass, including Text allocation-limit
  rollback and repeated post-fault reuse.
- `bun run check`, `bun run zig:check`, `bun tools/zig/api.ts`,
  `zig fmt --check impl/zig`, Python syntax checking and `git diff --check` pass.

Spec, Unicode tables, Cost Model, blessed expectations and saved formats do not
change. Host contiguous Text access keeps the same representation and strict
UTF-8 boundary.
