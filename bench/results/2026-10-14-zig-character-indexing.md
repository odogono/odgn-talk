# Zig Character indexing measurements, 2026-10-14

Evidence for [#927](https://github.com/odogono/odgn-talk/issues/927), comparing baseline
`8f98a485ba36daaded132329a530c6c492bbd6b7` with the Character read change at
`e052848a9df52f869a221c72b64c09d1ad1e004e`, before integration of #924. Both
binaries include the exact numeric paths from #923; no numeric code changes in
this task.
The [paired raw measurements](2026-10-14-zig-character-indexing.json) retain
five samples per process, three pairs, accounting, allocation probes, and binary,
source and generated-probe hashes. The [pre-edit intake](2026-10-14-zig-character-indexing-intake.json)
uses the same unmodified binary on both sides and confirms the unused-suffix cost.

Full-size `text/index` improves from 1.192 to 0.929 ms (1.28×, 22.1% less time)
with identical output, 26,640 Fuel and 51,072 logical bytes. Fixed-index probes
exclude modulo, equality and summation: the 16-Character early read improves
from 0.764 to 0.489 ms, and early reads no longer scale with the unused suffix.
Long negative indexing retains full segmentation and measured 6–8% slower;
that limitation and a separate recheck are recorded below.

## Implementation and scope

Forward Character reads keep two byte offsets and walk the existing pinned
grapheme boundary routine only through the requested end. Ranges clip to the
Characters present. A missing or reversed read still reports every Character
as scanned input. Negative indexes and ranges with a negative endpoint retain
the existing full-segmentation path, avoiding a count followed by a second walk.
Word, line, item and code-point segmentation, Unicode tables and grapheme rules
are unchanged.

The new path adds constant-sized local state and no segmentation allocations,
cache or retained Text metadata. Cache-specific retention, eviction and snapshot
accounting requirements therefore do not apply. Result Values still use the
Group allocator, physical cap and ordinary refusal handling. Tests exercise a
zero-capacity scratch allocator and refusal of result storage.

## Method

Apple M5, macOS 27.0.1, arm64; Zig 0.17.0 native `safe`, Apple clang 21.0.0
C Host at `-O2`, language 1.0-rc.3, Cost Model 0. Every process validates output
and accounting, then takes five samples, each averaging complete Runs over at
least 50 ms. Slow Runs can exceed that window. Load is outside Run timing.
Each sample repeats Runs on the same loaded Script. Tables use the median of
three process medians; process order alternates across pairs. Counting-allocator
probes run separately from default-allocator timings and require identical Fuel
and logical allocation. No builds, tests or profiles from this thread overlapped
paired timing. Other work was active on the machine; these are advisory results.

```sh
python3 bench/zig/character-indexing.py <before-host> <after-host> \
  --before-revision 8f98a485ba36daaded132329a530c6c492bbd6b7 \
  --out <results.json>
```

The fixed probes perform 1,000 reads and return the final selected Character
directly. ASCII sizes are 16, 256 and 4,096 Characters: `early` selects 8,
`late` selects the final positive index, and `last` selects -1. The Unicode
probe selects the ZWJ family from `éq́👨‍👩‍👧🇬🇧`. Loop and machine overhead
remain, so these timings are not isolated nanoseconds per boundary. In the
pre-edit intake, the fixed early probe rises from about 0.67 to 101 ms as the
input grows from 16 to 4,096 Characters.

## Paired timings

| Workload | Before ms | After ms | Speedup |
| --- | ---: | ---: | ---: |
| `text/build` | 0.540 | 0.551 | 0.98× |
| `text/iterate` | 0.855 | 0.855 | 1.00× |
| `text/index` | 1.192 | 0.929 | 1.28× |
| `text/patterns` | 0.728 | 0.736 | 0.99× |
| `text/graphemes` | 1.574 | 1.591 | 0.99× |
| `probe/ascii-16-early` | 0.764 | 0.489 | 1.56× |
| `probe/ascii-16-late` | 0.753 | 0.655 | 1.15× |
| `probe/ascii-16-last` | 0.811 | 0.815 | 0.99× |
| `probe/ascii-256-early` | 7.459 | 0.493 | 15.12× |
| `probe/ascii-256-late` | 7.068 | 5.533 | 1.28× |
| `probe/ascii-256-last` | 7.198 | 7.262 | 0.99× |
| `probe/ascii-4096-early` | 167.139 | 0.487 | 343.11× |
| `probe/ascii-4096-late` | 150.671 | 86.489 | 1.74× |
| `probe/ascii-4096-last` | 135.136 | 145.609 | 0.93× |
| `probe/unicode` | 0.780 | 0.641 | 1.22× |

Text construction, iteration, patterns and graphemes have median changes of
about 0–2%; no speedup is claimed for those unchanged paths. There is substantial
process variation: for example, the 16-Character early after medians are 0.489,
1.166 and 0.462 ms. The 4,096-Character early before medians are 167.139,
169.785 and 109.154 ms, versus 0.487, 0.691 and 0.465 after. The scaling gain
is clear, but the precise large speedup is sensitive to machine load.

## Negative-index recheck and profiles

The [targeted recheck](2026-10-14-zig-character-indexing-recheck.json) uses the
same binary hashes, three pairs and five samples, after the peer comparison.
The 4,096-Character negative-index medians are 149.297 versus 157.764 ms,
5.7% slower, with all three pairs slower. The original comparison was 135.136
versus 145.609 ms, 7.8% slower. This is a remaining measured regression on an
unchanged segmentation path; it is not dismissed as a proven noise artifact.
The same recheck retains the short early probe at 0.896 versus 0.700 ms (1.28×).

Separate [CPU sample summaries](2026-10-14-zig-character-indexing-profiles.json)
link both compressed raw call trees. Each macOS `sample` capture lasts two
seconds at 1 ms intervals, under repeated validated negative-index Runs,
outside all timings. Under `talk_pump`, segmentation covers 1,357/1,510 before
samples and 1,366/1,511 after; grapheme work covers 1,071 and 1,094 respectively.
No Decimal stacks appear. Inclusive categories overlap; inlining limits
attribution. Disassembly inspection found the same instruction counts in
`segment`, `grapheme.end` and `State.advance`, with relocated data references.
This shows no additional segmentation algorithm on the negative path, but
does not rule out code/data placement effects or machine-level variation.

## Physical allocation probes

Host bytes are cumulative Group allocation requests during one untimed Run,
excluding Load and process-owned Host values. Arena reuse means they are not
one request per temporary array. The counting allocator differs from the
default timing allocator. Live peak delta is relative to Run start; Group peak
includes Load. These are requested bytes, not resident memory.

| Workload | Calls before → after | Bytes before → after | Live peak delta before → after | Group peak before → after |
| --- | ---: | ---: | ---: | ---: |
| `text/index` | 1,030 → 1,029 | 16,577 → 14,253 | 11,934 → 10,784 | 35,449 → 35,449 |
| `probe/ascii-16-early` | 1,026 → 1,024 | 15,454 → 12,662 | 10,831 → 9,695 | 17,552 → 17,552 |
| `probe/ascii-256-early` | 1,029 → 1,024 | 94,678 → 12,662 | 50,407 → 9,695 | 58,865 → 24,490 |
| `probe/ascii-4096-early` | 1,032 → 1,024 | 1,914,526 → 12,662 | 960,295 → 9,695 | 989,293 → 47,826 |
| `probe/ascii-4096-last` | 1,033 → 1,033 | 1,914,894 → 1,914,894 | 960,663 → 960,663 | 989,665 → 989,665 |
| `probe/unicode` | 2,026 → 2,024 | 167,758 → 165,662 | 10,500 → 9,712 | 17,589 → 17,589 |

The 4,096-Character forward probe reduces cumulative requested bytes by 99.3%
and its Group peak from 989,293 to 47,826 bytes. Negative-index requests and
peaks are identical before/after. Logical allocation remains exactly equal
across every timing and allocation probe.

## Peer comparison and remaining gaps

The separate [fresh four-runner report](2026-10-14-zig-character-indexing-peers.md)
and [raw records](2026-10-14-zig-character-indexing-peers.json) use only native
Zig, the TS Core, AppleScript and GopherLua, at full text workload sizes:
`bun run bench --only zig,ts,gopher-lua,applescript --filter text --count 3`.
Zig and peers use three repeats; TS uses mitata automatic sampling. TS and
Zig agree on Fuel and logical allocation.

`text/index` is 0.827 ms Zig, 5.396 ms TS, 0.895 ms AppleScript and 0.119 ms
GopherLua. Zig takes about 7.6% less time than AppleScript here, closing this
workload’s original 1.77× AppleScript gap in this run. It remains about 6.97×
slower than GopherLua. Within these text workloads, construction remains
1.31× slower than AppleScript (0.477 versus 0.363 ms); iteration and patterns
remain faster. Other workload categories were not remeasured.

The 1.28× paired indexing improvement is additional to #923. Its evidence
recorded a separate 1.48× `text/index` improvement from numeric paths; those
earlier timings are not mixed with these pairs. Peers use native numbers and
idiomatic ports, so ratios are workload targets, not equivalent-instruction
costs or promised speedups. WASM and other Peer Language performance runners
were not used; WASI was exercised only for platform correctness.

## Verification

- `zig build install test corpus --summary all`: 220/220 tests and all 429
  Corpus cases pass. Every Trace Case also runs with save/restore between Pumps.
- `zig build corpus -- --defer-crossings`: all 429 cases pass again.
- Tests compare reads and scanned input with full segmentation across empty
  Text, ASCII/CRLF/control Characters, combining marks, prepend/ZWJ/Indic
  sequences, emoji, flags, all nearby positive/negative indexes and endpoint
  pairs, reversed/clipped/out-of-range reads and extreme i64 bounds.
- The zero-capacity scratch test failed before implementation and passes now;
  result allocation refusal still returns `OutOfMemory`.
- `zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi-927`,
  `uv run tools/wasi/zig.py .cache/zig-wasi-927/bin/talk.wasm` and
  `uv run tools/wasi/check.py .cache/zig-wasi-927/bin/talk.wasm` pass.
  The added wasm32 Character case repeats three Runs, including extreme i64
  bounds, CRLF and Unicode; each uses 141 Fuel and 1,014 logical bytes.
- `bun run check`, `bun run zig:check`, `bun tools/zig/api.ts`,
  `zig fmt --check impl/zig` and `git diff --check` pass.

No Spec, Unicode catalogue, Cost Model or blessed expectation records change.
