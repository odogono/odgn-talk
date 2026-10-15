# Local List write ownership investigation

Issue [#938](https://github.com/odogono/odgn-talk/issues/938), investigated at
`74f4307f` (including #935). The proposed last-use temp retirement fast path
is **rejected at the current machine seam**. Runtime implementation and
canonical instructions are unchanged. There is no claimed speedup. The issue
explicitly permits a documented rejection if sound ownership proof is too
invasive; this record takes that outcome rather than weakening immutable
Values, retained-state accounting or Save/Restore.

## Ownership characterization

[`Frame.write`](../../impl/zig/src/lower/lower.zig) evaluates the replacement,
indexes and delimiter into temp locals, stores the root and intermediate
wholes in more temps, loads the operands, performs the chunk setters, then
stores the rebuilt root. `Frame.release` only makes compiler slots reusable.
It emits no clearing instruction. The canonical local retains its last Value
until an actual store overwrites it or its frame is discarded.

Before even the second simple local replacement, the current whole is held
by the named source local, the whole temp and the operand stack. `load` takes
a reference; `chunks.set` borrows its input and takes another reference for
`listSet` to consume. Replacing the last-use load with a move removes only
one of those owners. Retiring the whole temp still leaves the named local,
whose canonical store happens after `chunk-set`. After that store, the temp
continues to hold the preceding version until a later store overwrites it.

The new instruction-stepping test executes two writes followed by a wait.
It checks at least three owners before each setter, the `[3, 2]` whole still
present after the second statement has produced `[3, 4]`, and the loss of
logical Persistent State if that whole is replaced by Nothing. Every boundary
is saved, restored, compared local by local, and resumed with matching Trace;
both suspended continuations return `[[1, 2], [3, 4]]`.

This is not just conservative reference counting. [Chapter 8](../../spec/08-the-abstract-machine-and-the-cost-model.md#logical-sizes) defines a frame's
contents as all local and operand Values, including temps. `frameHeader`
counts each local; `snapshot.Saving.frames` serializes each local. A dead
source-level value can therefore still be a live canonical retained Value.
Clearing it changes Persistent State limits. Saving only a logical-size
counter would also lose the original local Value needed to reproduce the
canonical saved frame. Canonical disassembly alone would not catch either
change.

Other owners and eligibility conditions remain independent:

- The retained original, Constants, Host arguments, captures, branched versions
  and collections of snapshots are real aliases. They cannot be retired.
- A protected instruction's `Operands.take` retains its inputs for the failed
  continuation. [Error-mode cleanup](../../spec/08-the-abstract-machine-and-the-cost-model.md#pending-cleanup-state) counts the original stack and owner locals;
  cancellation has separate truncation rules. No normal-path last-use proof
  authorizes changing either retained state.
- Script Variable Segment baselines hold rollback roots. Commit or rollback,
  rather than a local load's last use, ends their lifetime.
- Nested writes retain outer wholes which own their inner Lists. A unique
  leaf operand is insufficient if an earlier parent version must remain valid.
- A unique Value header may still share `list_storage`. Matching allocators,
  unique backing and a strictly lower-ranked inserted child are additional
  `listSet` requirements. Self-insertion, equal/higher ranks and hidden tails
  require the existing copy path to preserve acyclicity. Foreign allocators
  must produce Group-owned storage. Padded and range writes rebuild results.
- Restored/preempted frames retain canonical locals and stacks. A future
  specialization without valid lifetime metadata must use the ordinary path.

## Rejected fast paths and conditions for revisiting

Removing `whole.retain()` from the borrowed `chunks.set` API violates its
contract even for a singly owned List and a lower-ranked scalar replacement.
The new direct regression checks exactly this case, including every refused
allocation, without relying on a self-insertion or rank check to force a copy.

Moving last-use temps is insufficient to obtain uniqueness. Clearing all
apparently dead owners, including the source local before its store, changes
the canonical frame. Skipping safety just in unprotected code does not fix
preemption, Save or logical frame accounting. A metadata annotation on
`Frame.release` alone therefore cannot establish this fast path's safety.

A future path needs a representation that can retire physical owners while
still reproducing their complete canonical Values and logical sizes at every
instruction boundary. It also needs exception/refusal atomicity, protected
operands, nested reconstruction and restored-frame fallback. A persistent or
versioned spine with retained old-slot deltas is a separate design requiring
its own memory/cap and performance evidence; it is not implemented here.

## Measurement method

Native Zig 0.17.0 `safe`, C Host `-O2`, Apple M5, language 1.0-rc.3 and Cost
Model 0. The baseline Host was built before adding tests. The existing
`list-scaling.py` intake was repeated after compilation finished, avoiding
compiler contention in the published timing samples.
The ownership sweep uses `local-list-writes.py`: 8, 100, 1,000 and 3,000 items,
three alternating process pairs, three samples per process. Seeds are Constants
built during Load. Each timing sample averages complete checked Runs for at
least 50 ms on one loaded Script; a separate fresh counting-allocator Group
measures a single checked Run. Output, Fuel and logical allocation must agree.

The same baseline binary is passed on both sides because the optimization is
rejected. These pairs measure control variability, not before/after gains.
The snapshot workload performs 64 writes, retaining every produced version;
other workloads perform 128. At 128 snapshots of 3,000 items the growing
collection's logical allocation exceeds the unchanged 256 MiB Run budget, so
that is an allocation-limit case, not a usable timing sample.

## Size, allocations and memory

The [paired raw ownership sweep](2026-10-15-zig-local-list-writes.json)
contains all 60 pairs and their complete sources. A and B below are medians
of three process medians of the **same executable**. Allocation figures are
single-Run Group allocator requests, excluding Load; they agree across the
paired probes. These are not resident-memory figures.

| Retained original | A ms | B ms | Requests | Requested bytes | Run live-peak delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8 items | 0.066 | 0.060 | 156 | 21,265 | 11,126 |
| 100 items | 0.084 | 0.089 | 157 | 115,857 | 11,510 |
| 1,000 items | 0.428 | 0.455 | 157 | 1,037,458 | 23,651 |
| 3,000 items | 1.607 | 1.622 | 157 | 3,085,458 | 55,651 |

At 3,000 items, 128 requests of exactly 24,000 bytes account for 3,072,000
of the 3,085,458 requested bytes (99.6%): one full pointer spine per write.
The count remains 128 at 100 and 1,000 items, with sizes 800 and 8,000.
This directly identifies the allocation slope; it does not establish the
CPU time removable by ownership changes. Only a few versions are live in
the retained-original workload, so cumulative requests greatly exceed its
Run live-peak increase. Group peak including Load is 4,344,298 bytes at
3,000 items, with compiler/Constant storage included.

| Ownership case, 3,000 items | Writes | A ms | B ms | Requested bytes | Run live-peak delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| Retained original | 128 | 1.607 | 1.622 | 3,085,458 | 55,651 |
| Alias renewed each iteration | 128 | 1.661 | 1.648 | 3,085,465 | 55,659 |
| Every produced version collected | 64 | 0.882 | 0.849 | 1,597,936 | 1,590,291 |
| Protected by `finally` | 128 | 1.658 | 1.637 | 3,085,466 | 55,659 |
| Inner List in an outer List | 128 | 1.654 | 1.688 | 3,087,610 | 56,795 |

Snapshot collection keeps almost all its requests live. The nested case also
makes 128 outer single-item spines; it cannot consume the inner List while
the old parent still owns it. Protected writes have almost the same allocation
totals as ordinary writes: the protected operand references are an ownership
constraint, not evidence of an additional spine allocation.

The [collecting/spread/point-write intake](2026-10-15-zig-local-list-intake.json)
retains the existing sweep as a separate baseline. Its point writes replace
the last item with zero, whereas the ownership sweep inserts successive loop
numbers. Do not treat the two workloads as paired optimization measurements.
Every produced result has the expected output; all paired timing/probe Fuel
and logical allocation agree. For example, the 3,000-item retained-original
Run spends 51,347 Fuel and 4,248 logical allocation bytes while requesting
over 3 MiB physically. Snapshot collection at that size spends 149,957,192
logical bytes; these are existing Cost Model charges, not physical allocation.

## Separate CPU captures

The [profile record](2026-10-15-zig-local-list-profiles.json) retains two
separate two-second captures at 1 ms intervals of the unchanged eight-item
`collections/list-update` workload (1,500 replacements). The compressed
[A call tree](2026-10-15-zig-local-list-profiles/before-collections-list-update-slice-0.txt.gz)
and [B call tree](2026-10-15-zig-local-list-profiles/after-collections-list-update-slice-0.txt.gz)
include 1,529 and 1,532 Pump samples. The Host runs 300 validated timing
samples during capture and is terminated before its Load phase; none of these
captures overlaps the timing sweep.

| Inclusive named category | A | B |
| --- | ---: | ---: |
| `chunks.set` | 5.69% | 6.53% |
| `listSet` | 3.99% | 4.63% |
| `Value.release` | 7.06% | 7.11% |
| Allocator calls | 11.05% | 11.42% |
| Charging | 7.85% | 8.16% |

Categories overlap and must not be added. Inlining may attribute work to a
caller. Allocation/release also serve other instructions; their percentages
are not estimates of removable point-write cost. Both captures use SHA-256
`97e06e23f623ad2daa0c15f086b894eb662acf73379fa18fce5b3255b732fdb6`, the same
baseline executable as the ownership sweep.

## Current peers and residual gap

The [focused four-runner report](2026-10-15-zig-local-list-peers.md) and
[raw results](2026-10-15-zig-local-list-peers.json) refresh only
`collections/list-update`, with three Zig/peer samples and automatic TS
sampling. This uses the current checkout with test/documentation changes;
there is no point-write optimization. Zig and TS both spend 28,553 Fuel and
24,328 logical allocation bytes, with the retained original checked by the
workload result.

| Runner | Run median ms |
| --- | ---: |
| Native Zig | 0.569 |
| TS Core | 2.571 |
| AppleScript | 0.421 |
| GopherLua | 0.0351 |

The residual AppleScript gap is **1.35×**, versus the issue's historical
1.59× at `f51ad856`. The current base includes #935; this comparison cannot
attribute the changed ratio to a rejected optimization. Peers retain their
idiomatic ports and native numeric types. No other performance runner was
used; WASI checks below are conformance/containment checks only.

Reproduction, after building the native Host as in `measure-zig.ts`:

```sh
python3 bench/zig/list-scaling.py <baseline-host> --count 3 --out intake.json
python3 bench/zig/local-list-writes.py <baseline-host> <baseline-host> --before-revision 74f4307f --pairs 3 --count 3 --out ownership.json
python3 bench/zig/instruction-bookkeeping.py <baseline-host> <baseline-host> --before-revision 74f4307f --profiles-only --filter collections/list-update --profile-filter collections/list-update --profiles profiles --out profiles.json
bun run bench --filter collections/list-update --only zig,ts,applescript,gopher-lua --count 3
```

## Verification and scope

- Final native `safe` `zig build test -j4 --summary all`: 232/232 Zig tests
  pass, plus the C Host tests. The two added tests exercise a unique borrowed
  lower-rank replacement with every allocation refusal, and two local writes
  with instruction-by-instruction preemption, restored locals, logical size
  and suspended continuation agreement.
- All 429 native Corpus cases pass, including ordinary/restored replay and
  canonical disassembly. All 429 also pass with `--defer-crossings`.
- Existing tests cover retained originals, branching/snapshots, self-insertion,
  hidden tails, ownership ranks, foreign allocators, padded/range replacement,
  saturated sums, rollback, cancellation, failed cleanup, physical caps and
  allocation refusal. No expected record was changed.
- The native and `wasm32-wasi` builds pass. Both `uv run tools/wasi/zig.py`
  and `uv run tools/wasi/check.py` pass: C API, containment, memory and Message
  Layer checks. The reactor is 3,027,221 raw bytes and 690,758 Brotli bytes.
- `bun test tests/zig-runner.test.ts` from `tooling/fuzz`: both tests and all
  33 assertions pass, comparing complete TS/Zig witness and mutation Traces.
- Spec checks, lint, formatting, generated Zig/API checks, documentation links,
  pinned Unicode data, Python compilation and Zig formatting pass.

This delivers ownership characterization, reproducible measurements and a
regression-backed rejection. Local machine point writes continue to copy;
there is no enabled fast path, claimed performance improvement or changed
Spec/Cost Model. Revisiting storage representation remains separate work.
