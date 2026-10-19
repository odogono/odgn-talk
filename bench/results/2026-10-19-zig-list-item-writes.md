# Zig List item-write measurements — 2026-10-19

Evidence for [#1291](https://github.com/odogono/odgn-talk/issues/1291).

The retained change reduces List update from 0.475 to 0.379 ms in three paired
process rounds, below the issue's 0.391 ms AppleScript reference. It preserves
28,553 Fuel, 24,328 logical allocation bytes, output 1501, the complete canonical
frame, and physical allocation requests. This is about 20% less Run time.
The speedup comes mainly from cheaper local-instruction and operand handling,
not from mutating retained Lists or eliminating their spine copies.

## Diagnosis and implementation

`collections/list-update` replaces item 1 of an eight-item local List 1,500
times while keeping the original. `chunks.set` borrows that whole, retains it,
and calls `listSet`, which copies the spine. Lowering temps and named locals
retain prior versions as described by the
[ownership investigation](2026-10-15-zig-local-list-writes.md). Those references
remain live and unchanged, including across instruction preemption and Save.

`collections/list-append` instead grows a Script Variable, retaining the initial
List. `listGrow` can extend unused storage beyond an older version's visible
slice, so it does not copy a complete spine on every append. Replacement cannot
use that growth rule. Before optimizing, the new baseline measured 0.477 ms for
update and 0.809 ms for append; update exceeded the issue's reference.

Separate two-second CPU samples at 1 ms intervals compare both workloads,
before and after. The baseline update capture has 1,519 Pump samples:
`chunks.set` contains 93 (6.1%), `listSet` 64 (4.2%), and `Value.release` 117
(7.7%). Append has 1,525 Pump samples, with no setter calls and 111 release
samples (7.3%). Setter-only work is too small to explain the whole desired
improvement. Loads, stores, stack pushes and releases surround every write.
Categories overlap; inlining attributes some work to callers, so these are
not additive estimates of removable time.

The implementation:

- Handles local `load`, `store` and `move` in a small inline dispatch path.
  These operations need no code-unit lookup and are never restricted
  operations. Their existing bodies move unchanged; each still executes at
  the ordinary charging, retention and preemption boundary.
- Pushes directly into available operand-stack capacity, preserving the
  allocating fallback and its release-on-refusal contract.
- Inlines the shared-reference decrement. Final-reference destruction still
  uses the iterative, allocation-free teardown, including hidden List tails.
- Uses the existing narrow constructor for a copied List's Value header and
  active payload, avoiding the whole-node poison and full Data-union copy.
  It initializes all headers and retains the same children after allocation.

There is no new buffer cache, changed layout, instruction fusion, lifetime
metadata, logical-size shortcut, unsafe build mode or save-format change.
A small-pointer-buffer cache experiment was rejected because it slowed append.
Skipping the final Value poison alone did not materially improve update and
was also discarded. Narrow List construction alone measured 0.466 ms and
was insufficient to meet the target.

## Paired timings and accounting

Apple M5, macOS arm64, Zig 0.17.0 `safe`, language 1.0-rc.3, Cost Model 0.
The baseline is `3ba52a1d5baf1d7a45f982383dfceafbe5bfb342`; the after Host uses
this change. The [raw paired record](2026-10-19-zig-list-item-writes.json)
retains binary hashes, baseline/current runtime source hashes, manifest and
generator hashes, every timing sample and separate allocation probes.

Three alternating AB/BA process rounds use three samples per process. Every
sample averages checked Runs for at least 50 ms on one loaded Script. All
compilation finishes before the recorded timings; CPU captures run separately.
The broader suite has 36 variants, including sliced calls/loops, Fibonacci's
slice sweep, straight-line moves and protected loops: 108 comparisons.
All 36 median paired ratios improve, ranging from 1.00× to 1.49×;
the median variant's paired speedup is 1.16×. This shared machine has timing
variation; these are observed samples, not guaranteed speedups.

- `collections/list-update`: 0.475 → 0.379 ms; paired speedups 1.33×, 1.21×, 1.31×.
- `collections/list-append`: 0.810 → 0.692 ms; paired speedups 1.23×, 1.17×, 1.26×.
- `collections/list-build`: 0.194 → 0.152 ms; paired speedups 1.28×, 1.28×, 1.28×.

List-update's three after process medians are 0.358, 0.392 and 0.379 ms.
The middle process is just above the historical reference; the median of
process medians is below it. Fresh peer measurements are recorded below.

Every before/after timing and counting probe has identical Fuel and logical
allocation. Across all 108 comparisons, counting probes also agree on parent
allocation/free counts, requested bytes and size attribution, peak-live delta,
and Group used/peak bytes. For update, both request 104,408 bytes in 1,527
parent allocations, including 1,503 requests of 64 bytes. The Group peak is
42,770 bytes. These are allocation observations, not RSS measurements.

The [ownership sweep](2026-10-19-zig-list-item-writes-ownership.json) retains
60 paired cases: 8, 100, 1,000 and 3,000 items; retained originals, renewed
aliases, every version collected, protected writes and nested Lists. Seeds
are built at Load, outside Run timing. Snapshot cases use 64 writes and other
cases 128. The Host checks each expected result; Fuel and logical allocation
agree. Long Lists still copy a complete pointer spine per replacement, so this
change does not remove their linear per-write work.

The [CPU captures](2026-10-19-zig-list-item-writes-profiles/) contain compressed
call trees for append and update, before and after. The after update capture
has 1,519 Pump samples, with 128 in `chunks.set`, 100 in `listSet` and 78 in
release/destruction. The increased setter share is consistent with cheaper
surrounding work; relative sample shares are not absolute-time measurements.

## Reproduction

Build each revision's native Host as in `bench/ts/src/measure-zig.ts`, retaining
a separate executable for each. Use the repository's pinned Zig and safe mode.

```sh
python3 bench/zig/instruction-bookkeeping.py <before-host> <after-host> --before-revision 3ba52a1d --pairs 3 --count 3 --profiles profiles --profile-filter collections/list-update --profile-filter collections/list-append --out paired.json
python3 bench/zig/local-list-writes.py <before-host> <after-host> --before-revision 3ba52a1d --pairs 3 --count 3 --out ownership.json
bun run bench --filter collections/list-update --only zig,applescript,gopher-lua --count 5 --no-save
```

The timing feedback check is the median List-update after process median at or
below 391,000 ns, with Fuel 28,553 and logical allocation 24,328. It fails on
the measured baseline and passes on the paired result. Permanent tests assert
behavior and exact accounting, without a machine-dependent timing threshold.

## Fresh peer comparison

The [five-repeat peer report](2026-10-19-zig-list-item-writes-peers.md) measures
native Zig at 0.352 ms, AppleScript at 0.373 ms, and GopherLua at 0.0262 ms.
Zig is 5.6% below the freshly measured AppleScript median as well as below the
issue's historical 0.391 ms reference. The after peer run is separate from the
paired timings and uses the same production sources, rebuilt after adding the
accounting regression test. Its recorded dirty revision is intentional.

All 60 ownership cases also preserve parent allocation/free counts, requested
bytes and size attribution, peak-live delta, and Group used/peak bytes. The
speedup does not come from retaining less canonical state or relaxing budgets.

## Verification and limits

The regression runs the full 1,500-write workload with unsliced and 100-Fuel
Pumps, checking the retained original, result 1501 and exact Run charges.
The existing instruction-by-instruction List test checks every canonical local,
Persistent State accounting, Save/Restore and matching resumed Traces. Existing
Value/chunk tests cover borrowed inputs, aliases, self-insertion, hidden tails,
ownership ranks, saturated measures, foreign allocators and allocation refusal.

- `zig build test -j4 --summary all`: all 371 Zig tests pass, plus the C
  Host tests.
- All 446 native Corpus cases pass in ordinary and deferred-crossing replay,
  including canonical disassembly and restored continuations.
- `bun run check`: 168 tool tests pass, plus Spec, grammar, machine, corpus,
  syntax, Unicode, Lint catalogue, documentation links and save-format checks.
- Zig formatting, generated tables and C API coverage checks pass.
- `uv run tools/wasi/zig.py` and `uv run tools/wasi/check.py`: WASI C API,
  containment, memory and Message Layer checks pass.
- `CGO_ENABLED=0 impl/go/zig-experimental-check.sh`: the uncommitted reactor
  hand-swap gate passes, including Go embedding, sessions, persistence and
  adapter tests. The hand-swapped files are restored before provenance is built.
- `bun test tests/zig-runner.test.ts` in `tooling/fuzz`: both tests and all
  33 assertions pass against complete TS/Zig witness and mutation Traces.

Inlining grows the measured native Host's `__TEXT` from 2,060,824 to 2,093,984
bytes (33,160 bytes, 1.6%). The verified reactor is 3,416,012 raw bytes and
767,201 Brotli bytes. These costs accompany the instruction-path speedup.
There is no claim of unique machine point writes or improved asymptotic List
replacement complexity. No expected Trace, Data File or Cost Model is changed.
