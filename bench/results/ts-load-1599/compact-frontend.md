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

## Time-boxed structural prototype

After `c6a6bfdc`, three further commits tested the cheapest structural slices of a
single-pass front end. Each keeps Fuel, the Trace, code identities and
diagnostics unchanged.

| Commit | Change | Evidence |
| --- | --- | --- |
| `8a04bbd0` | Checker builds per-site token and node lists and the clash token map on demand | Checker-only time 1.95 → 1.78 ms, large |
| `9565c2f0` | Load path climbs operator precedence in one task instead of a task per level | Three alternating Bun pairs: large 9.97 → 8.87 ms (11%), small 25.6 → 24.0 µs (6%) |
| `1712dde5` | Checker builds semantic nodes in its bounds walk; Name tokens fill in after binding | Checker-only 2.28 → 1.9 ms; within end-to-end noise |

Precedence climbing produced identical Load trees, node offsets and errors for
all 817 `.talk` files in the repository. The merged walk produced identical check
results (tree, scopes and diagnostics) for the same files. Core tests, the Corpus,
lint and formatting passed.

Together the two structural slices saved about 15% of large Load, below the 25%
bar set for continuing to a fused front end. Merging site marking and binding
would change the order in which later passes overwrite sites. Lowering still
reads a semantic tree that must be allocated.
[ADR 0132](../../../docs/adr/0132-ts-load-targets-10x-zig-without-a-single-pass-front-end.md)
records the decision to target 10× and keep a single-pass front end out of scope.

Suite runs with `--only ts,zig --count 5` on the same machine, which was more
heavily loaded than for the earlier tables:

| Load | TS | Zig | TS / Zig |
| --- | ---: | ---: | ---: |
| small | 24.0 µs | 3.6 µs | 6.7× |
| large (two runs) | 9.53 / 9.52 ms | 0.907 / 0.926 ms | 10.5× / 10.3× |
| macro/game-tick | 115.0 µs | 15.8 µs | 7.3× |
| macro/report | 67.3 µs | 8.7 µs | 7.7× |
| macro/transform | 112.3 µs | 14.9 µs | 7.5× |

A Node Load-only spot-check measured 20.5 µs small and 8.46 ms large.
Large-Script Load remains just outside 10×.

## Lexer and semantic-pass follow-ups

| Commit | Change | Evidence |
| --- | --- | --- |
| `0a8ff41f` | The lexer reuses the last line for positions; the parser copies a token only when continuation trivia must be merged | In-process interleaved parse and check, large: 7.3%, 9.7%, 8.0% less time |
| `509e0bf8` | The decision pass indexes only `veto` and `pass` leaves; the suspension pass looks for `and wait` only on statements that take it | Same method, six runs: median about 3% less time |

Both produced identical Load checks, public checks and public parse trees
for all 817 `.talk` files against the preceding commit. Core tests, the
Corpus and lint passed. Comment trivia is retained because Load's
documentation reads it.

Other processes held the machine at load averages of 12–20 during these
measurements. Suite runs gave large Load 10.8× and 11.9× of Zig, with TS at
about 12.1 ms against about 9.5 ms on the quieter machine earlier, so they are
not evidence for the ratio. Whether large Load is within 10× needs a rerun on
an idle machine.

## Idle-machine recheck

At load averages of 1–2, three suite runs with `--only ts,zig --count 5`:

| Load | TS | Zig | TS / Zig |
| --- | ---: | ---: | ---: |
| small | 18.5 / 19.0 / 19.3 µs | 2.8 / 3.3 / 3.3 µs | 6.6× / 5.8× / 5.8× |
| large | 6.31 / 6.66 / 6.73 ms | 0.784 / 0.765 / 0.771 ms | 8.1× / 8.7× / 8.7× |

One macro run: game-tick 95.1 / 13.2 µs (7.2×), report 54.7 / 7.7 µs (7.1×),
transform 87.0 / 13.0 µs (6.7×).

`bun run bench:compare origin/main --filter lifecycle/load --rounds 3 --node`
against `d61c535b`, medians of round medians with non-overlapping ranges:

| Runtime | Load | `main` | This branch | Change |
| --- | --- | ---: | ---: | ---: |
| Bun | small | 0.025 ms | 0.019 ms | −21.7% |
| Bun | large | 12.4 ms | 6.82 ms | −44.8% |
| Node | small | 0.022 ms | 0.017 ms | −20.7% |
| Node | large | 12.9 ms | 6.02 ms | −53.2% |

Run times were unchanged (within ±1.3%). Every Load workload is within the 10×
target of [ADR 0132](../../../docs/adr/0132-ts-load-targets-10x-zig-without-a-single-pass-front-end.md).
