# TS Text fact caches (#1581)

Measured on 26 October 2026 on an Apple M5 (10 cores, 24 GiB), macOS arm64,
Bun 1.4.4 and Node 26.12.1. Baseline: `915eae6e6c8faf8afd613628d0562baaa398b3cd`
(`origin/main` at intake). Candidate: the accompanying implementation on
`feat/issue-1581`; [measurements.json](measurements.json) records source hashes,
every process result and Node samples.

## Run times

Times are milliseconds. Bun columns are medians of the three process medians;
Node columns are medians of two process medians. Negative changes mean less time.

| Workload | Bun before | Bun after | Change | Node before | Node after | Change |
| - | -: | -: | -: | -: | -: | -: |
| macro/game-tick | 1.992 | 2.034 | +2.1% | 3.235 | 3.288 | +1.6% |
| macro/report | 1.145 | 0.618 | -46.0% | 0.976 | 0.438 | -55.1% |
| macro/transform | 0.855 | 0.857 | +0.2% | 1.058 | 1.053 | -0.4% |
| text/build | 0.491 | 0.282 | -42.6% | 0.491 | 0.280 | -42.9% |
| text/graphemes | 2.834 | 1.664 | -41.3% | 3.226 | 2.588 | -19.8% |
| text/index | 0.990 | 0.983 | -0.7% | 1.480 | 1.308 | -11.7% |
| text/iterate | 1.016 | 0.907 | -10.7% | 1.577 | 1.475 | -6.4% |
| text/patterns | 3.922 | 3.849 | -1.9% | 3.657 | 3.386 | -7.4% |

`text/build`, `text/graphemes` and `macro/report` improve on both runtimes.
The Bun `text/iterate` gain is smaller. The other Bun results are within the
expected ±5–8% run variation. Node is a spot-check with a separate timing
harness, so its absolute times should not be compared with Bun's mitata times.
No timing measurements ran concurrently with tests or builds.

Fuel, output and logical allocation match exactly between the Node variants on
all eight workloads; all Bun processes also agree on Fuel and logical allocation.
Heap figures in the JSON are Bun's noisy sample-growth estimates, not retained
memory measurements.

## Reproduction

Archive the baseline source into a separate directory and run
`bun install --frozen-lockfile` there. Run the following commands once on the
baseline and then once on the candidate, repeating three times in that order:

```sh
bun run bench --only ts --count 5 --no-save --filter text/
bun run bench --only ts --count 5 --no-save --filter macro/
```

The recorded order was baseline text, candidate text, baseline macro, candidate
macro, repeated three times. mitata selects its own TS sample count; `--count 5`
is retained for consistency with the repository's comparison command. The
baseline archive has no `.git`; the CLI's inherited outer-worktree dirty label
is not its source revision. The explicit baseline SHA above identifies it.

For Node, copy [node-worker.ts](node-worker.ts) into the same relative directory
in the baseline archive. Bundle the worker separately against each checkout:

```sh
bun bench/results/ts-text-facts-1581/build-node.ts \
  bench/results/ts-text-facts-1581/node-worker.ts .cache/text-facts-node.mjs
node .cache/text-facts-node.mjs
```

[build-node.ts](build-node.ts) preserves the suite's source directory when
bundling for Node. Each process checks the manifest output, warms up 30 times,
and collects 15 batches of at least 50 ms per workload. Run baseline/candidate,
then candidate/baseline in fresh processes.

## Validation

- TS tests and examples: 6,601 passed, 75 skipped, no failures across 136 files.
  The additional long-build regression passed in the focused five-test run.
- Full TS Corpus: all 468 cases passed, including Built-ins and the Text model;
  existing Trace expectations and Fuel are unchanged.
- Cost Model parity tests passed with cached combining-mark, CRLF and flag joins.
- Every split of the pinned normalization cases and grapheme test rows agrees
  with full normalization and segmentation. Additional three-piece joins,
  retained originals, all ASCII pairs, long builds and Character slices passed.
- Workspace type checking, lint and formatting checks passed.

## Implementation

Text storage caches ASCII status, UTF-8 length, Character count and frozen
Character/boundary arrays. ASCII joins add counts with a CRLF correction.
Unicode joins normalize and re-segment their boundary context, including leading
RI runs, Indic extenders and emoji Extend/ZWJ sequences, then adjust the cached
measurements. Contiguous Character slices skip NFC normalization. General
construction still validates scalar text and applies the pinned Unicode normalizer.
