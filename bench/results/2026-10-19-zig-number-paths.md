# Zig numeric paths — 2026-10-19

Evidence for [#1290](https://github.com/odogono/odgn-talk/issues/1290), against
`6d39b827db2153f0497b8db004e19332097ba109`. This base includes #1289's instruction
fast path: addition, multiplication and division already beat AppleScript at
intake. Quantity was the remaining gap, at 0.155–0.160 ms against approximately
0.117–0.123 ms for AppleScript. The issue's older baseline predates #1289 and
must not be used to attribute its gains to this change.

The [paired measurements](2026-10-19-zig-number-paths.json) retain complete
samples, output checks, accounting, separate allocation probes, source/binary
hashes and CPU captures. The [four-runner report](2026-10-19-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua.md)
and its [JSON](2026-10-19-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua.json)
compare the final native Zig build with TS, AppleScript and GopherLua on the
four numeric workloads.

## Method

Apple M5, macOS 27.0.1, arm64, Zig 0.17.0 in `safe` mode, C Host built with
`zig cc -O2`, language 1.0-rc.3 and Cost Model 0. Three paired processes per
workload use five samples per process, each averaging validated Runs for at
least 50 ms. Process order alternates before/after and after/before. Compilation,
Load and separate counting-allocator probes are outside Run timing. CPU
sampling runs only after paired timings finish; the peer comparison follows
the CPU captures. No builds or checks from this thread overlap timings.

Other work was active on the shared machine. All samples are retained, including
slow ones; per-process spreads below distinguish the paired evidence from a
single quiet measurement. These are advisory timings for this machine.

## Numeric results

| Workload | Paired before ms | Paired after ms | Final Zig ms | AppleScript ms | Fuel |
| --- | ---: | ---: | ---: | ---: | ---: |
| `numbers/add` | 0.1279 | 0.1275 | 0.1285 | 0.2241 | 26,030 |
| `numbers/multiply` | 0.0824 | 0.0824 | 0.0821 | 0.1702 | 18,031 |
| `numbers/divide` | 0.1292 | 0.1139 | 0.1147 | 0.1889 | 18,031 |
| `numbers/quantity` | 0.1554 | 0.1164 | 0.1160 | 0.1163 | 14,579 |

Quantity's three process medians span 0.1548–0.1555 ms before and 0.1162–0.1174 ms after. Final Zig medians also beat all four AppleScript times from the issue's 2026-10-18 reference; the fresh comparison above uses the same final source.

All compared Runs preserve exact output, Fuel and logical allocation. The
general arithmetic oracle, Spec and blessed expectations are unchanged.

## Remaining costs and implementation

The baseline Quantity CPU capture places 56.1% of Pump samples below the general instruction dispatcher, 21.0% below Unit operations and 9.0% below Decimal arithmetic. These are overlapping inclusive categories, affected by inlining. Further Decimal big-integer replacement alone could not explain the remaining gap after #877, #923 and #939. All four numeric workloads have before/after CPU captures in the paired JSON and its linked profile directory.

- Extend the existing instruction fast path to numeric division, `div`/`mod`,
  Quantity arithmetic and static numeric Unit conversion. The general loop
  remains responsible for errors, refusals, protected cleanup and unsupported
  operands. Each instruction retains its own charge and preemption boundary.
- Separate arithmetic/conversion results from Value allocation. Reuse only
  uniquely held numeric locals or conversion temporaries; shared Values retain
  their original content. Plain Number arithmetic keeps a separate narrow
  specialization, avoiding a runtime Data union on every counting step.
- A Decimal divisor with coefficient one needs no wide quotient/remainder
  helper. Exponent selection, overflow fallback and zero clamping still run.
- A single non-ratio Unit Kind needs only its active conversion phase. Keep
  every factor and repetition in order. Exact identity factors can skip work
  for nonzero values; zeros and positive exponents retain Decimal clamping.
  Ratio and compound Units retain the ordered general traversal.
- Quantity construction initializes every header and active payload without
  whole-node poisoning, using the same allocation size, alignment and owner.
  Keep its larger initializer out of generic scalar callers.

Inlining that initializer caused an 18–25% `macro/report` regression during
development. Saved intermediate binaries isolated the change, and three new
pairs with `quantityScalar` outlined removed it while retaining the numeric
gain. The [constructor control](2026-10-19-zig-number-constructor-control.json)
records both variants. The final broad measurements below use the outlined
constructor.

## Broader workloads and allocations

All 36 workload/Slice combinations ran in three pairs, including all 26 supported manifest workloads. The table gives selected broader checks; the JSON retains every sample and allocation probe.

| Workload | Before ms | After ms | After / before |
| --- | ---: | ---: | ---: |
| `core/loop` | 0.1426 | 0.1429 | 1.002 |
| `core/fib` | 0.2970 | 0.3012 | 1.014 |
| `text/build` | 0.0549 | 0.0546 | 0.994 |
| `collections/list-build` | 0.0742 | 0.0742 | 1.000 |
| `macro/report` | 0.4487 | 0.4601 | 1.025 |
| `macro/game-tick` | 0.8862 | 0.8877 | 1.002 |
| `probe/protected-loop` | 0.3711 | 0.3708 | 0.999 |
| `probe/protected-loop @ Slice 100` | 0.4225 | 0.4205 | 0.995 |

Among combinations taking at least 0.01 ms, the largest median increase is `macro/report` (Slice 0): 0.4487 to 0.4601 ms (2.5%). These small shifts are not uniform gains; the earlier constructor-sized text regression is absent.

Physical allocation requests can differ because the fast path reuses storage;
Fuel and logical allocation cannot. The counting allocator is a separate probe,
not a measure of resident memory or allocation by Zig's default allocator.
Its Group peak includes Load.

| Workload | Host allocations before → after | Requested bytes before → after | Group peak before → after | Logical allocation |
| --- | ---: | ---: | ---: | ---: |
| `numbers/add` | 23 → 23 | 7,480 → 7,480 | 25,780 → 25,780 | 32,104 |
| `numbers/multiply` | 24 → 24 | 7,739 → 7,739 | 30,256 → 30,256 | 32,104 |
| `numbers/divide` | 24 → 24 | 7,738 → 7,738 | 29,996 → 29,996 | 32,104 |
| `numbers/quantity` | 26 → 25 | 8,258 → 8,002 | 30,752 → 30,752 | 40,088 |

## Reproduction and validation

Build a baseline and final native library with `zig build` in `impl/zig`,
then link the same Host against each library:

```sh
zig cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c impl/zig/zig-out/lib/libtalk.a -o /path/to/host
python3 bench/zig/instruction-bookkeeping.py /path/to/before /path/to/after \
  --before-revision 6d39b827db2153f0497b8db004e19332097ba109 --pairs 3 --count 5 \
  --source-file impl/zig/src/units.zig --source-file impl/zig/src/decimal/decimal.zig \
  --source-file impl/zig/src/machine/convert.zig --profile-filter numbers/ \
  --profiles /path/to/profiles --out /path/to/results.json
bun run bench --only zig,ts,applescript,gopher-lua --filter numbers/ --count 5
```

Final validation:

- 376 Zig tests and native C Host checks pass. Arithmetic oracle comparisons
  cover coefficient-one division, signs, zero and exponent boundaries; Unit
  conversion compares against the original ordered traversal, including
  subnormals, ratios, compound Units and unbounded comparison intermediates.
- All 446 corpus cases pass normally and with deferred crossings, including
  restored replay. Blessed expectations remain unchanged.
- Fast/general loop Traces agree across Fuel/allocation boundaries, Fuel
  Slices, alias retention, refused result nodes, arithmetic errors and
  `finally` cleanup. Constructor tests verify every header, payload, allocation
  size and refusal before publication.
- Safe WASI, reactor protocol and native sidecar checks pass, as do the
  differential fuzz witnesses/mutations and the Go adapter's full experimental
  compatibility gate against the rebuilt reactor.
- Repository checks, generated tables, Unicode, API coverage, lint, formatting
  and Zig formatting pass. The save format remains `zig/13`.
