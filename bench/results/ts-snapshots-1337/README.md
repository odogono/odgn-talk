# Native TS compact snapshot measurements (#1337)

Measured 2026-10-19 on Darwin arm64. Baseline: `dcd92dd1bcd8b8557281146008704dacea8d307a` (format 9). Candidate: the format-10 implementation accompanying this report. These controlled synthetic fixtures are not Mercenary production measurements.

The representative fixture loads six Scripts totaling 19,002 source characters and binds the same 16 UI Operations to each Script. The four scenarios retain zero Runs, one pending Capability message per Script, one timer per Script, or three concurrent Runs per Script (two messages and one timer).

## Sizes

All sizes are bytes except base64, which counts ASCII characters. Graph columns measure the decoded serialized graph, before the old outer wrapper escapes it.

| Scenario | Baseline raw / base64 | Embedded raw / base64 | External raw / base64 | Graph old → new |
| --- | ---: | ---: | ---: | ---: |
| idle | 60,740 / 80,988 | 28,996 / 38,664 | 9,281 / 12,376 | 4,970 → 2,399 |
| message | 87,474 / 116,632 | 41,052 / 54,736 | 21,337 / 28,452 | 27,652 → 14,455 |
| timer | 81,600 / 108,800 | 38,321 / 51,096 | 18,606 / 24,808 | 22,774 → 11,724 |
| concurrent | 134,414 / 179,220 | 60,103 / 80,140 | 40,388 / 53,852 | 67,632 → 33,506 |

External-source raw saves are 70–85% smaller than the baseline across these scenarios. Their graphs are 48–52% smaller. Embedded-source snapshots also benefit from declaration sharing, graph tuples/dictionaries and removal of wrapper escaping.

## Timings

Bun 1.4.3; separate Save and Restore medians in milliseconds, 30 samples after five warmups. Restore includes source loading, integrity checks and state validation, but no Pump or settlement. Timing is advisory and these short runs do not establish a latency guarantee.

| Scenario | Baseline save / restore | Embedded save / restore | External save / restore |
| --- | ---: | ---: | ---: |
| idle | 0.810 / 8.173 | 0.876 / 7.763 | 0.714 / 6.569 |
| message | 1.031 / 7.747 | 1.065 / 6.918 | 0.918 / 6.844 |
| timer | 1.191 / 15.179 | 0.954 / 6.278 | 0.876 / 6.308 |
| concurrent | 1.365 / 7.495 | 1.270 / 6.639 | 1.197 / 6.653 |

## Independent dimensions and runtime verification

- `one-script` and `twelve-scripts` vary Script count; declaration records remain shared.
- `long-sources` pads the same code to 60,000 characters. Every external-source size equals its representative counterpart; the embedded source payload grows.
- `one-operation` and `wide-declarations` vary declaration width independently of code and state.
- `state-100` and `state-500` retain that many rows per Script. All size/timing rows are included in the JSON files.
- The bundled benchmark also ran under Node 26.12.0 (3 timing samples). All 64 raw-size records matched Bun, and both modes restored successfully in every fixture/scenario.

## Reproduction

Run from the repository root:

```sh
bun bench/ts/src/snapshots.ts --samples=30 > candidate.json
bun build bench/ts/src/snapshots.ts --target=node --outfile=.cache/snapshots.mjs
node .cache/snapshots.mjs --samples=3 > node-smoke.json
```

For the baseline, extract the complete `impl/ts/src` tree at the baseline commit into a temporary checkout, copy the benchmark to `bench/ts/src/snapshots.ts` there, and run it with `--baseline --samples=30`. Run baseline and candidate sequentially with no concurrent tests or builds.

Artifacts: [baseline](baseline.json), [candidate](candidate.json), [Node smoke](node-smoke.json). There is no absolute KB acceptance threshold. Source-length regression tests, declaration sharing and measured graph reductions are the acceptance criteria.
