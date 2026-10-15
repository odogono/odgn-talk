# Zig ordered Map storage — 2026-10-15

Flat small Maps and shared ordered blocks reduce copying while preserving insertion
order, immutable retained versions, Fuel, logical allocation and the Save format.
The focused native sweep passes the agreed small-Map and peak-memory review limits.

## Storage and interface

The value module owns Map construction, ordered indexed reads, updates and deletion.
Callers use `Map.len`, `Map.at`, `Value.get` and explicit borrowed-entry copies when
they need temporary sortable arrays. They do not depend on contiguous Map storage.
The C interface remains unchanged: indexed entry access is constant-time and borrows
keys for the lifetime of its Map.

Maps with at most 64 entries remain flat. Larger Maps own an exact directory of
reference-counted immutable blocks of at most 32 entries. Replacement copies the
directory and one block; append copies the final partial block or creates another.
Only the changed block duplicates keys and retains children. Other blocks are shared.
There are no hidden tail entries, per-key reference headers, hash indexes or new adapters.
Every allocation completes before the new root is published. Final block release
queues children into the existing allocation-free iterative Value teardown.

Logical contents sizes update incrementally, with a full recomputation when the old
sum saturated. Ownership rank remains greater than every physical child. Deletion
rebuilds ordered storage inside the value module, retaining its previous error-metadata
behavior, and avoids redundant validation of existing NFC keys. It remains linear
in entries copied; this work does not claim constant-time deletion or key lookup.

The 64-entry crossover is conservative, not a proven global optimum. The final sweep
checks both sides and keeps small Maps within the agreed regression allowance.

## Measurement method

Baseline: `f0ec960a`. Candidate: this working-tree implementation on that base.
Native Apple M5, macOS arm64, Zig 0.17.0 `safe`, C Host built with
`cc -std=c11 -O2 -Wall -Wextra -Werror`. The [raw record](2026-10-15-zig-map-storage.json)
contains platform/tool versions, source and executable hashes, generated Scripts,
all samples, allocation probes and per-pair changes.

Three alternating process pairs, five samples per process: 56 workloads and 168
pairs. Sizes are 0 (empty construction), 1, 4, 8, 16, 32, 33, 64, 65, 100, 1,000 and
3,000. Workloads cover construction, replacement with a retained original, collecting
versions, deletion/reinsertion and 128-byte key prefixes. Update Runs perform 128
writes; snapshots at 1,000 and 3,000 entries use 32 writes to stay within the existing
logical allocation limit. Smaller snapshot workloads retain 128 versions.

Load and destruction are outside Run timing. Each sample averages checked Runs for
at least 50 ms. Counting-allocator probes use separate fresh Groups and one checked
Run. Output, Fuel and logical allocation agree in every pair and probe. This thread’s
builds and verification completed before this final sweep; unrelated machine activity
is not controlled. Timing remains advisory, not a CI gate.

## Paired timings

Change is the median of three after/before ratios. Absolute times are medians of
per-process medians and may not divide to the same ratio.

| Workload | Entries | Before ms | After ms | Change |
| --- | ---: | ---: | ---: | ---: |
| build | 100 | 0.1353 | 0.0974 | -27.4% |
| build | 1,000 | 9.6080 | 1.5452 | -83.9% |
| build | 3,000 | 89.6800 | 8.9972 | -89.9% |
| replace | 100 | 0.2271 | 0.1080 | -52.1% |
| replace | 1,000 | 1.9562 | 0.1121 | -94.3% |
| replace | 3,000 | 6.8849 | 0.1203 | -98.3% |
| snapshots | 100 | 0.2324 | 0.1238 | -46.7% |
| snapshots | 1,000 | 0.4876 | 0.0335 | -93.2% |
| snapshots | 3,000 | 1.6432 | 0.0354 | -97.9% |
| delete | 100 | 1.2407 | 0.3036 | -75.8% |
| delete | 1,000 | 87.4460 | 2.4160 | -97.2% |
| delete | 3,000 | 649.6280 | 7.3683 | -98.9% |
| long-keys | 100 | 0.2830 | 0.1207 | -57.3% |
| long-keys | 1,000 | 2.5189 | 0.1232 | -95.1% |
| long-keys | 3,000 | 9.1320 | 0.1329 | -98.5% |

## Acceptance limits

- Small Maps: no repeatable median slowdown above 5%. The largest observed median
  increase among workloads through 64 entries was **3.72%**, for eight-entry replacement.
- Memory: reject growth above the larger of 10% and 4 KiB, separately for whole-Group
  peak and Run live-peak delta. **Zero failures** across all 168 paired probes.
- Cumulative requested bytes are allocation traffic, not resident memory. Whole-Group
  peaks include Load; Run live-peak delta exposes changes that compiler peaks can hide.

| Workload, 3,000 entries | Requested bytes before → after | Run live-peak delta before → after | Group peak before → after |
| --- | ---: | ---: | ---: |
| build | 124,469,957 → 3,845,140 | 940,397 → 861,960 | 946,469 → 868,032 |
| replace | 11,006,337 → 221,057 | 178,137 → 10,214 | 7,323,584 → 7,323,584 |
| snapshots | 2,777,504 → 81,184 | 2,770,899 → 74,579 | 7,324,146 → 7,324,146 |
| delete | 21,996,929 → 11,576,065 | 263,973 → 185,568 | 7,045,884 → 7,045,884 |
| long-keys | 65,936,641 → 825,089 | 1,036,280 → 18,912 | 13,833,893 → 13,833,893 |

## Broader regression check

The [native regression record](2026-10-15-zig-map-storage-regressions.json)
covers all 36 supported workload/slice/probe combinations, three pairs and five
samples per process (108 pairs). Outputs, Fuel and logical allocation agree.
The sweep flagged `messaging/suspend` at +11.15% median change (individual
pairs −24.3%, +11.2%, +12.0%). The [five-pair, ten-sample recheck](2026-10-15-zig-map-storage-suspend-recheck.json)
measured +1.95% median change, ranging from -15.5% to +25.0%.
The original slowdown did not reproduce consistently; the large spread remains
visible in the records. All other workload medians are within 5% or faster.
Both peak-memory limits also pass across all 108 broad-regression pairs.
The sweep includes collection iteration, arithmetic, text, calls, macros and preemption.
These are the native Host's supported workloads, not a claim of complete Host
Capability or messaging benchmark coverage.

## Validation

- 241 native tests pass, plus C Host tests, including indexed access across blocks.
- New exhaustive allocation-refusal coverage exercises promotion, shared replacement,
  self-insertion, retained versions and deletion back to flat storage.
- A 65-entry Map test saves and restores suspended shared versions byte-for-byte,
  resumes them and checks Segment rollback.
- All 429 corpus cases pass, including deferred Host crossings. No blessed expectations
  or normative instructions changed.
- WASI reactor and Message Layer checks pass, including Map physical-cap containment
  and healthy fresh Groups after refusal.
- TS/Zig differential tests: two tests and 33 assertions pass.
- Spec/generated-data/documentation checks, C interface catalogue and Zig formatting pass.

## Reproduction

```sh
python3 bench/zig/map-storage.py <before-host> <after-host> \
  --before-revision f0ec960a --pairs 3 --count 5 --out results.json
python3 bench/zig/instruction-bookkeeping.py <before-host> <after-host> \
  --before-revision f0ec960a --pairs 3 --count 5 --out regressions.json
```

Build both native Hosts before timing, as described in `bench/ts/src/measure-zig.ts`.
This preserves ADR 0001’s Value Semantics, ADR 0010’s normative accounting and
instruction behavior, and ADR 0054’s advisory benchmarking policy.
