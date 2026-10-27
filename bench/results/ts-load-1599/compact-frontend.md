# Compact strict compilation for #1599

Continuation of the [scope report](../../../docs/research/ts-load-front-end-scope-1599.md)
after its profiling checkpoint, `01864c1f`, on 2026-10-27. This is a measured
representation reduction, not a completed single-pass frontend or the 5× target.

## Retained change

The existing recognizer omits an expression precedence wrapper on the internal
Load/compile path when its only child is another node. Operators, explicit Kind
productions, declarations, bindings and scope boundaries remain. It uses the
same lexical modes, lookahead decisions, productions and explicit task stack.
The public parser/checker and recovering tooling tree retain all productions.

| Workload | Full syntax nodes | Compact syntax nodes | Tokens on both paths |
| --- | ---: | ---: | ---: |
| small | 26 | 12 | 12 |
| large | 16,728 | 4,818 | 4,859 |

[Node counts](compact-node-counts.json) show a 71% reduction in large-workload
nodes. The reduction reaches checking and semantic-to-view conversion as well
as parsing. It adds no source cache and never generates JavaScript.

## Paired measurements

Apple M5, 10 cores, 24 GiB, darwin arm64; Bun 1.4.4 (`5d9cc0f4f`),
Node v26.12.1. Baseline and candidate bundles use the ordinary
`bench/ts/src/measure-ts.ts` worker, including its heap sampling. Only the four
changed Core files are substituted from `01864c1f` in the baseline. Both variants
are bundled identically. Every Load has a fresh Group and Script name.

Three fresh-process pairs alternate order: before/after, after/before,
before/after. No tests, builds or other benchmark jobs run concurrently. mitata
chooses TS sample counts; the suite's `--count 5` controls native Zig repeats.
Timings remain advisory.

| Load | Baseline medians | Candidate medians | Median of medians |
| --- | ---: | ---: | ---: |
| small, µs | 40.42 / 39.79 / 37.96 | 36.88 / 39.46 / 34.75 | 39.79 → 36.88; 7.3% less time |
| large, ms | 23.05 / 23.86 / 27.99 | 18.34 / 18.05 / 16.61 | 23.86 → 18.05; 24.3% less time |

The earlier Load-only trial, without timed Runs and heap sampling, measured
27.08 → 15.03 ms large (44.5% less time). The ordinary-worker comparison above
is the conservative end-to-end result used for this change. These runners and
sampling budgets must not be mixed into a single percentage.

A separate Node Load-only spot-check measured small **30.88 → 28.79 µs**
and large **43.07 → 14.75 ms** (65.8% less time for large). One pair does not
establish a Node performance distribution.

Single-pair ordinary-worker Load spot-checks:

| Macro workload | Before | After | Less time |
| --- | ---: | ---: | ---: |
| transform | 218.7 µs | 165.3 µs | 24.4% |
| report | 112.3 µs | 87.7 µs | 21.9% |
| game-tick | 238.8 µs | 164.5 µs | 31.1% |

The tooling edit/reanalyse spot-check was 80.20 → 70.04 ms. Its public parsing
and checking path retains full trees, and the pair has only twelve samples per
variant, so this is not evidence of an incremental-LSP improvement.

Every measured workload retained expected output, Fuel and logical allocation.
Raw records: [Bun pairs](compact-bun-paired.json), [Node](compact-node.json),
[macro before](compact-macro-before.json), [macro after](compact-macro-after.json),
[tooling before](compact-tooling-before.json), [tooling after](compact-tooling-after.json).
[Metadata](compact-metadata.json) records versions and before/after source hashes.

## Target and remaining work

A separate ordinary-suite recheck with `--only ts,zig --count 5` measured:

| Load | Candidate TS | Zig | TS / Zig | 5× budget |
| --- | ---: | ---: | ---: | ---: |
| small | 38.7 µs | 3.7 µs | 10.5× | 18.5 µs |
| large | 17.20 ms | 1.069 ms | 16.1× | 5.34 ms |

[Raw suite output](compact-suite.txt) includes Fuel parity. The 5× target remains
open. The small Zig time varies materially between local runs; the paired TS
figures are the evidence of improvement, not a ratio against an earlier Zig run.

A separate five-second [candidate CPU profile](compact-large.cpuprofile.gz)
assigns 46.8% inclusive samples to `checkParsed`, 35.3% to `parseSourceTree`,
10.8% to lowering and 4.3% to `viewSource`. Task driving/generator resumption
occupies overlapping parser/lowering stacks; `runTask` is 41.6% inclusive.
These percentages overlap, include verification/startup, and cannot be added as
independent savings. See the sample counts in metadata.

Compaction validates reducing intermediate structure without replacing the
recognizer. The next prototype should reduce precedence-task/frame overhead and
checker context work while preserving shared recognition, exact first-error
behavior and deferred cross-body checks. A full fused rewrite is still not
justified solely by these timings. Incremental editor invalidation remains a
separate workload.

Checker bounds/conversion fusion, lazy token contexts, token-copy avoidance and
fact-index trials did not show consistent end-to-end gains. A compact-frame
shared-buffer trial added complexity without improving on the simpler compact
representation. None is retained.

## Validation and reproduction

- Core suite: 6,610 passed, 75 skipped, no failures. Skips require the optional
  Zig reactor artifact, which was absent.
- Corpus: all 468 selected cases passed against unchanged expectations.
- Lowering fixtures now compare compact compilation against public full-tree
  checking/lowering, including diagnostics and exact disassembly.
- Authored syntax-error fixtures compare first error codes and tokens on both
  paths; public/recovering lossless trees retain their existing checks.
- Combined lowering/syntax fixtures: 1,660 passed. Workspace typechecking,
  changed-file lint and formatting passed.

Build the paired workers from the repository root:

```sh
bun bench/results/ts-load-1599/compact-build-runners.ts 01864c1f
bun bench/ts/dist/compact-bun-before.js lifecycle/load
bun bench/ts/dist/compact-bun-after.js lifecycle/load
node bench/ts/dist/compact-node-before.js lifecycle/load
node bench/ts/dist/compact-node-after.js lifecycle/load
bun run bench --only ts,zig --filter lifecycle/load --count 5 --no-save
```

Repeat Bun pairs in alternating order. Use `macro/` or `tooling/` in place of
`lifecycle/load` for their spot-checks. Keep bundles directly in `bench/ts/dist`
for the suite's relative fixture lookup. Build before measuring, and capture
CPU profiles separately using the Load-only entry documented in the scope report.
