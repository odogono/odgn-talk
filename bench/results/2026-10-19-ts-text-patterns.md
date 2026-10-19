# TS Text Pattern measurements, 2026-10-19

Evidence for [#1294](https://github.com/odogono/odgn-talk/issues/1294), comparing
`3ba52a1d5baf1d7a45f982383dfceafbe5bfb342` with the uncommitted candidate.
Bun 1.4.3, Apple M5, macOS 27.0.1, arm64. The raw records retain source and
bundle hashes, the implementation diff, workload sources, every timing sample,
per-process load averages, separate Load samples and heap probes.

`text/patterns` improves from **5.671 to 4.833 ms**, or **14.8% less Run time**
(1.17×). The opposite process order gives 5.625 → 4.818 ms, or 14.3% less time.
Every full-size Run still returns `900`, uses **13,818 Fuel** and allocates
**231,372 logical bytes** at N = 300. These are local measurements, with shared
machine interference recorded below.

## Dominant costs and changes

The baseline [CPU profile summary](2026-10-19-ts-text-patterns/profiles.json)
attributes 20.8% of self samples to three map-related `Object.freeze` callers:
the public Map constructor, persistent Map insertion and cached ordered pairs.
Logical sizing accounts for 14.4%, persistent tree work 10.3%, other Value code
10.4%, and the matcher 8.8%. Pinned Unicode segmentation is a smaller cost.
Native freezing samples are separate from the source-file percentages.

The public Map constructor froze each validation pair before Map storage copied
and froze it again. Removing the first freeze keeps the same immutable stored
pairs and input snapshots. An initial paired experiment isolating this change
reduced Run time by 11–15%, which motivated retaining it alongside the matcher
change.

The Pike VM now reuses two thread lists, one generation-marked instruction array
and one pending-branch stack within a run. Jumps and the preferred split branch
continue directly, creating thread objects only at consuming or match
instructions and pending alternatives. Saves still copy Capture slots, and
thread priority, seeding, deduplication and exact `steps` remain the same.
Scratch storage belongs to each invocation.

In the after profile, matcher self samples fall to 6.8%; the public constructor's
duplicate pair-freeze caller disappears. Logical sizing (17.7%) and remaining
map/tree construction still dominate. Profile shares include startup, warm-up
and validation; they establish attribution, not the timing speedup.

## Method and results

```sh
bun bench/ts/src/compare-text-patterns.ts 3ba52a1d .cache/ts-patterns
bun bench/ts/src/compare-text-patterns.ts 3ba52a1d .cache/ts-patterns-reversed '' after
bun bench/ts/src/compare-text-patterns.ts 3ba52a1d .cache/ts-patterns-recheck text/patterns
```

Only `patterns.ts` and `values.ts` are substituted in the before bundle; all
other sources are identical. The existing chunk-read worker validates every
Run, warms up five Runs, then records five samples of repeated Runs lasting at
least 50 ms each. Each workload has three fresh before/after process pairs,
alternating order. Reported times are medians of the three process medians.
Ten fresh-name Load samples per process exclude Run time. Profiles use separate
processes with 20 warm-up Runs and three seconds of validated Runs.

The [first comparison](2026-10-19-ts-text-patterns/before-first.json) overlapped
other Zig builds. Its `text/patterns` process medians span 6.590–16.842 ms before
and 5.673–9.134 ms after, and its `text/index` control has a 27.007 ms process
median. It does not establish a speedup.

The [opposite-order comparison](2026-10-19-ts-text-patterns/after-first.json)
measures `text/patterns` at 5.625 → 4.818 ms. Controls measure `core/loop` at
3.866 → 3.948 ms, `text/index` at 1.859 → 1.891 ms, `collections/map-build` at
1.128 → 1.197 ms and `collections/map-update` at 0.634 → 0.638 ms. In particular,
Map building measures 6.1% slower; these results do not establish a general
Map performance improvement.

The [target recheck](2026-10-19-ts-text-patterns/target-recheck.json) reverses
that comparison's order again. Before process medians are 5.627–5.746 ms; after
medians are 4.825–4.845 ms. This reproduces the target improvement in both orders.

Separate 20-Run heap probes in the recheck observe 867,112 → 709,901 bytes of
uncollected JSC heap growth and 12,996 → 9,910 additional objects. Retained heap
after collection is 8,040,480 → 8,308,433 bytes. These single probes are heap
observations, not total allocation measurements or evidence of lower retained
memory. Logical allocation is unchanged.

Full heap observations are retained separately for the
[first comparison](2026-10-19-ts-text-patterns/before-first-heap.json.gz),
[opposite order](2026-10-19-ts-text-patterns/after-first-heap.json.gz) and
[target recheck](2026-10-19-ts-text-patterns/target-recheck-heap.json.gz).

Raw [before](2026-10-19-ts-text-patterns/before.cpuprofile.gz) and
[after](2026-10-19-ts-text-patterns/after.cpuprofile.gz) CPU profiles accompany
the summary. To collect them from the emitted bundles:

```sh
bun --cpu-prof --cpu-prof-dir=.cache/ts-patterns-profiles \
  .cache/ts-patterns-recheck/before.js \
  .cache/ts-patterns-recheck/workloads.json profile text/patterns
```

Use `after.js` for the other variant. Keep timing and profiling sequential.

## Verification

- 6,201 TS Core and Example Host tests pass; 24 optional tests skip.
- All 446 original TS corpus cases pass, with unchanged expectations.
- All 168 benchmark tests, workspace typechecks, repository lint, formatting
  and Spec/generated-data/documentation checks pass.
- Six added matcher cases pin Capture priority, empty repetitions and steps.
- A disposable differential probe compares 220 generated captured patterns on
  12 subjects, including Unicode, with seed 1294. All 105,600 comparisons of
  matches, Capture slots and steps agree with the baseline across four run
  kinds, every start position, first-match stopping and Match Search limits.

Specification, Cost Model, Fuel charging and corpus expectations are unchanged.
