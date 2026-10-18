# TS messaging and lifecycle overhead

For [#1292](https://github.com/odogono/odgn-talk/issues/1292), skipping unobserved Trace formatting and Trace-only retained-state counting reduces the four messaging workloads by about 29–48% in alternating batches. Empty Handler execution also improves. Restore is effectively unchanged, and rollback results vary between initialization orders; no consistent rollback speedup is established.

Baseline: `f67b03f2`, with the same TS Core sources as the issue's `63675505`. Only `impl/ts/src/group.ts` is substituted between bundles. The after variant is the accompanying change. Machine: Apple M5, 10 cores, macOS arm64, Bun 1.4.3, default JIT and GC settings. Fuel, logical allocation and output agree on every measured Run. Cost Model data and save format are unchanged.

## Requested benchmark reruns

Commands, run separately before editing and after the change:

```sh
bun run bench --filter messaging --only ts --no-save
bun run bench --filter lifecycle --only ts --no-save
```

The initial rerun measured joins at 18.885 ms and parents at 13.536 ms, below both the issue's 26.29/17.53 ms and the 10-15 report's 21.231/15.556 ms. The reported joins/parents regression is not confirmed by these reruns. These separate suite runs establish context; the alternating comparisons below isolate the change.

| Workload | Initial rerun ms | After ms | Fuel |
| --- | ---: | ---: | ---: |
| messaging/sends | 13.242 | 7.130 | 67518 |
| messaging/parents | 13.536 | 8.118 | 67518 |
| messaging/joins | 18.885 | 12.577 | 127218 |
| messaging/suspend | 11.873 | 5.808 | 48018 |
| lifecycle/restore | 6.077 | 6.166 | 8015 |
| lifecycle/rollback | 45.363 | 42.820 | 102023 |

The raw [baseline messaging](2026-10-18-ts-messaging-lifecycle/baseline-messaging.txt), [baseline lifecycle](2026-10-18-ts-messaging-lifecycle/baseline-lifecycle.txt), [after messaging](2026-10-18-ts-messaging-lifecycle/after-messaging.txt) and [after lifecycle](2026-10-18-ts-messaging-lifecycle/after-lifecycle.txt) reports include Load separately. Small-Script Load was 30.4 → 28.9 µs, and large-Script Load was 15839.3 → 14873.1 µs. The paired Run timings below exclude compilation.

## Paired Run timings

Each self-contained bundle owns its own Core and loaded Groups in the same process. Per workload: 20 warm-up Runs per variant, then three rounds of seven paired batches of ten Runs, alternating AB/BA. Each Run checks output, outcome, exact Fuel and logical allocation. A second sweep reverses bundle import, probe construction and warm-up order. Profiling, heap snapshots and other verification commands run outside these timings.

Cells show the median batch mean in milliseconds, before → after, separately for the two initialization orders. The last column spans all six round ratios, before median / after median; above 1 favors after. Raw records retain all 42 batch means per variant, workload sizes, exact accounting, source diff, hashes and host load averages. These are advisory measurements on a shared workstation.

| Workload | Before initialized first ms | After initialized first ms | Round ratios |
| --- | ---: | ---: | ---: |
| core/loop | 2.7733 → 2.8662 | 2.8774 → 2.8687 | 0.96–1.09× |
| host/immediate | 1.7912 → 1.4114 | 1.7651 → 1.3908 | 1.22–1.33× |
| host/pump | 0.0113 → 0.0081 | 0.0116 → 0.0084 | 1.30–1.54× |
| messaging/sends | 14.1445 → 9.0446 | 12.9093 → 8.1960 | 1.52–1.67× |
| messaging/parents | 17.0553 → 11.1835 | 14.8597 → 9.4462 | 1.41–1.64× |
| messaging/joins | 22.8388 → 15.8768 | 19.5295 → 13.9330 | 1.34–1.55× |
| messaging/suspend | 12.2393 → 6.3815 | 10.0583 → 5.4213 | 1.72–1.96× |
| lifecycle/load-small | 0.0077 → 0.0049 | 0.0061 → 0.0045 | 1.29–1.69× |
| lifecycle/load-large | 0.6854 → 0.5565 | 0.6287 → 0.6073 | 0.96–1.44× |
| lifecycle/restore | 8.3165 → 8.1896 | 6.8950 → 6.9775 | 0.97–1.07× |
| lifecycle/rollback | 39.4392 → 47.8201 | 59.8165 → 51.6969 | 0.81–1.19× |

Messaging improves in every round under both initialization orders. The core/loop control and restore show no consistent gain. Rollback reverses from a slowdown when before initializes first to an improvement when after initializes first. A separate-process comparison also varies by round ([raw process pairs](2026-10-18-ts-messaging-lifecycle/process-timings.json.gz)). This order sensitivity prevents attributing a stable rollback gain or regression to the change.

Raw data: [before-first batches](2026-10-18-ts-messaging-lifecycle/timings.json), [after-first batches](2026-10-18-ts-messaging-lifecycle/after-first-timings.json), [summary](2026-10-18-ts-messaging-lifecycle/summary.json).

## CPU profiles

Each workload and variant runs in a separate process for three seconds after 20 warm-up Runs. Percentages count samples inside the worker's validated Run function, including warm-up. Trace formatting is the union of stacks containing `recordLine`, `traceValue` or `formatInstant`; Persistent State is the inclusive `Group.persistentState` share and can overlap other categories. JIT inlining and sampling limit attribution. These shares identify costs; the timed comparisons establish speedups.

| Workload | Trace formatting before → after | Persistent State before → after |
| --- | ---: | ---: |
| messaging/suspend | 36.5% → 0.1% | 6.9% → 1.4% |
| messaging/sends | 14.3% → 0.1% | 6.6% → 2.1% |
| messaging/joins | 15.2% → 0.1% | 4.8% → 2.5% |
| messaging/parents | 13.7% → 0.0% | 12.7% → 7.2% |
| lifecycle/restore | 0.1% → 0.1% | 13.9% → 14.4% |
| lifecycle/rollback | 12.7% → 2.6% | 1.0% → 0.1% |

The dominant removable messaging cost is unused Trace construction, including Clock formatting for each Pump and retained-state counting for `seg` records. Group tracing is now optional, so optional calls skip their arguments. Reports, observers, Wait handling and record retention still execute. Deferred input-line functions still run because Broadcast recipient selection happens there. Enabled Trace output retains its existing ordering and text.

Restore spends about 27% of baseline samples in `restoreGraph`, 17% in SHA-256 and 14% in Persistent State counting; these paths remain. Rollback spends about 42% in Capability execution, including suspending-call setup and abandonment; Trace removal does not eliminate that work. The exact shares and validated profile Run counts are in the [profile summary](2026-10-18-ts-messaging-lifecycle/profiles.json), which links all twelve compressed raw captures.

Separate [before](2026-10-18-ts-messaging-lifecycle/heap-before.json.gz) and [after](2026-10-18-ts-messaging-lifecycle/heap-after.json.gz) heap/GC observations follow timing, with warm-up, full GC, 20 validated Runs and another full GC. They describe occupancy, not total allocation. Logical allocation is unchanged, and no uniform memory or GC-time reduction is claimed.

## Verification

- Full TS tests: 6195 pass, 24 WASM tests skipped without the reactor artifact, zero failures.
- All 446 corpus cases replay with existing expectations, including enabled Trace output.
- All 168 benchmark tests pass.
- New traced/untraced parity test covers Broadcast recipient selection, preemption, suspended Joins, rollback, reports, Inspect and identical save bytes before and after restore.
- Repository typecheck, lint and formatting checks pass; the TS package builds.

## Reproduction

```sh
bun bench/ts/src/compare-messaging-lifecycle.ts f67b03f2 .cache/ts-messaging-lifecycle
bun bench/ts/src/compare-messaging-lifecycle.ts f67b03f2 .cache/ts-messaging-lifecycle-reversed '' after
bun bench/ts/src/compare-messaging-lifecycle.ts f67b03f2 .cache/ts-rollback lifecycle/rollback after
bun --cpu-prof --cpu-prof-name=before-suspend.cpuprofile --cpu-prof-dir=.cache/ts-messaging-lifecycle .cache/ts-messaging-lifecycle/before.js .cache/ts-messaging-lifecycle/workloads.json profile messaging/suspend
bun --cpu-prof --cpu-prof-name=after-suspend.cpuprofile --cpu-prof-dir=.cache/ts-messaging-lifecycle .cache/ts-messaging-lifecycle/after.js .cache/ts-messaging-lifecycle/workloads.json profile messaging/suspend
```

Repeat the profile commands for the other five workloads in the summary. Run measurements sequentially. The optional third argument filters workload names; the fourth selects which Core initializes first. The helper writes isolated timing/profiling bundles, fixtures, every batch sample, hashes and separate heap observations. The standalone worker comes from `character-indexing-worker.ts`; its explicit workload input includes messaging and lifecycle Hosts.
