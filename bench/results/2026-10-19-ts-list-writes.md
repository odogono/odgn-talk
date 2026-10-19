# TS iteration recheck and List point writes (#1293)

Measured on 2026-10-19 on Apple M5, macOS arm64, Bun 1.4.3. The optimization
baseline is `918fde6b2d10412418400c9a77929ea0039d6e02`; the candidate is its
uncommitted List-storage and item-index changes for
[#1293](https://github.com/odogono/odgn-talk/issues/1293).
The [raw record](2026-10-19-ts-list-writes.json) contains timings, workload
sources, accounting, source/bundle hashes, host load averages and heap summaries.
Timings are advisory and do not change the Cost Model.

## Iteration slowdown did not reproduce

Three independent runs of
`bun run bench --filter collections/iterate --only ts --no-save` measured
1.676, 1.615 and 1.646 ms at the current baseline, all at 89,459 Fuel.

To check the issue's historical interval, both complete TS source trees and
their benchmark sources were extracted with `git archive`. The archived suite's
package import alone was redirected to its archived TS index, and both used
the frozen workspace's mitata installation. Three alternating runs of each
revision's `bench/ts/src/measure-ts.ts collections/iterate` gave:

| Revision | Run 1 ms | Run 2 ms | Run 3 ms | Fuel |
| --- | ---: | ---: | ---: | ---: |
| `f51ad856` | 5.442 | 5.485 | 5.455 | 89,459 |
| `63675505` | 5.243 | 5.166 | 5.176 | 89,459 |

The later revision was about 5% faster in this recheck. There is no reproduced
48% slowdown to bisect. These measurements do not establish what caused the
original two reports to differ; mitata sampling and host conditions remain
possible explanations. The current checkout also includes subsequent execution
optimizations, so its lower absolute time is a separate observation.

## Replacement work

A separate three-second Run profile identified List replacement and index
handling as hot paths. Previously, replacement located a chunk, copied it,
searched by key to insert it, rebuilt AVL metadata and searched both endpoints.
Replacement cannot change shape, spans or endpoint keys. It now copies the
affected chunk and its path in one positional traversal, preserving metadata.
Deletion retains its existing rebalancing and endpoint handling.

In-bounds scalar List writes also resolve existing small integer indexes
directly, including negative indexes. Other numeric representations, ranges,
padding and errors continue through general index handling.

## Paired timings

`compare-collections.ts` bundles the same Core twice, substituting only
`list-storage.ts` and `operations.ts` from the baseline for the before variant.
Each workload runs three fresh process pairs in alternating order. Each process
warms up for five Runs and records five batches lasting at least 50 ms each.
The figures below are medians of the three process medians. Every Run checks
completed output, exact Fuel and logical allocation against its first Run;
the driver also requires equality across variants and rounds.

| Workload | Before ms | After ms | Change |
| --- | ---: | ---: | ---: |
| collections/list-update, after-first comparison | 0.9563 | 0.8382 | −12.4% |
| collections/list-update, before-first recheck | 0.9689 | 0.9018 | −6.9% |
| collections/list-append | 3.1929 | 3.0679 | −3.9% |
| collections/map-update | 0.4211 | 0.4274 | +1.5% |
| collections/iterate | 1.6303 | 1.6171 | −0.8% |
| macro/transform | 1.3224 | 1.2027 | −9.1% |
| collections/list-build, first comparison | 0.4963 | 0.5441 | +9.6% |
| collections/list-build, independent recheck | 0.5122 | 0.5060 | −1.2% |

The construction slowdown did not reproduce. Small changes on the surrounding
workloads should be treated as noise. List-update improved in every pair of
both final comparisons, with unchanged **28,553 Fuel**, **24,328 bytes logical
allocation** and result `1501`. Its unbundled mitata check measured 0.856 ms
before and 0.800, 0.765 and 0.778 ms after.

Retained-List probes perform 128 replacements against Lists loaded as Script
Variables; their initial construction is outside Run timing. Every probe
checks both the retained original and the replacement result. First/last writes
at 32 and 33 elements exercise the chunk boundary.

| List length / item | Before ms | After ms | Change |
| --- | ---: | ---: | ---: |
| 1 / 1 | 0.0970 | 0.0932 | −3.9% |
| 32 / 1 | 0.1001 | 0.0967 | −3.3% |
| 32 / 32 | 0.1025 | 0.0968 | −5.6% |
| 33 / 1 | 0.1022 | 0.0970 | −5.1% |
| 33 / 33 | 0.0993 | 0.0969 | −2.4% |
| 512 / 1 | 0.1116 | 0.0935 | −16.2% |
| 512 / 512 | 0.1126 | 0.0983 | −12.6% |
| 8,192 / 1 | 0.1225 | 0.1115 | −9.0% |
| 8,192 / 8,192 | 0.1232 | 0.1151 | −6.6% |

## Profiles and memory observations

Separate three-second captures are retained as
[before](2026-10-19-ts-list-writes-profiles/before.cpuprofile.gz) and
[after](2026-10-19-ts-list-writes-profiles/after.cpuprofile.gz).
Of 2,026 before samples, `set` accounts for 183, `at` for 54 and `integerOf`
for 30. Of 2,018 after samples, `set` accounts for 2, `replaceItem` for 98,
`at` for 33 and `integerOf` for 7. Inlining and different Run counts prevent
treating sample shares as direct speedup measurements.

Separate heap probes record memory before 20 Runs, before collection and after
forced full GC. The List-update process's current memory after GC was 71.66 MB
before and 71.96 MB after. These snapshots do not measure total allocation or
prove a memory reduction. Full observations, including allocator/type details,
are retained in [before heap](2026-10-19-ts-list-writes-profiles/before.heap.json.gz)
and [after heap](2026-10-19-ts-list-writes-profiles/after.heap.json.gz).

## Reproduction and verification

```sh
bun bench/ts/src/compare-collections.ts 918fde6b .cache/ts-collections '' after
bun bench/ts/src/compare-collections.ts 918fde6b .cache/ts-collections-recheck collections/list-update
bun bench/ts/src/compare-collections.ts 918fde6b .cache/ts-collections-build collections/list-build
bun --cpu-prof --cpu-prof-dir=.cache/ts-collections .cache/ts-collections/before.js .cache/ts-collections/workloads.json profile collections/list-update
bun --cpu-prof --cpu-prof-dir=.cache/ts-collections .cache/ts-collections/after.js .cache/ts-collections/workloads.json profile collections/list-update
```

The TS Core and examples pass 6,209 tests, with 24 optional reactor tests skipped
because no Zig WASM artifact is built in this checkout. All 446 TS Corpus cases,
workspace typechecking and linting of changed TS files pass. Collection tests
cover retained branches, replacements around chunk boundaries, growth after
endpoint deletion, positive/negative/general indexes, padding, invalid indexes,
rollback and Save/Restore. Timing remains a benchmark observation rather than
a CI assertion.
