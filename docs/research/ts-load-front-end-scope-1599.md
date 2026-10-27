# TS Load front-end scope (#1599)

## Scope decision

Keep the **5× Zig Load target**, and admit a **bounded frontend-fusion prototype**
for strict compilation. The previous exclusion of single-pass frontend work in
[#1579](https://github.com/odogono/odgn-talk/issues/1579) should no longer constrain
investigation. Do not commit to replacing the frontend until a prototype shows
end-to-end gains. Incremental LSP analysis is useful, but is a separate workstream:
it does not satisfy fresh-Group Load acceptance.

This completes the profiling and scope-decision step of
[#1599](https://github.com/odogono/odgn-talk/issues/1599), not its performance target.
The profiling checkpoint `01864c1f` retained no Core optimization. The benchmark
harness and raw evidence below make that decision reproducible. Subsequent
[compact-compilation results](../../bench/results/ts-load-1599/compact-frontend.md)
record the retained implementation and remaining gap.

## Measurements

Measured on 2026-10-27 at `40b76697f661eb5e9d08a1938a6b0bc310035b64`
(`origin/main` at intake), on an Apple M5, 10 cores, 24 GiB, darwin arm64.
Bun 1.4.4 (`5d9cc0f4f`), Node v26.12.1, Zig 0.17.0, native safe build and
C Host compiled with `zig cc -O2`; language 1.0-rc.3, Cost Model 0.

Two independent ordinary-suite runs used:

```sh
bun run bench --only ts,zig --filter lifecycle/load --count 5 --no-save
```

| Workload | Bun TS Load medians | Zig Load medians | Paired TS / Zig | 5× Zig budget |
| --- | ---: | ---: | ---: | ---: |
| `lifecycle/load-small` | 37.8 / 40.8 µs | 4.3 / 5.4 µs | 8.8× / 7.6× | 21.5 / 27.0 µs |
| `lifecycle/load-large` | 30.90 / 37.96 ms | 1.090 / 1.164 ms | 28.3× / 32.6× | 5.45 / 5.82 ms |

The larger variation here exceeds the previous ±5–8% expectation; use the
ranges, not an isolated timing, for planning. The gap survives both runs.
Large Load needs about an 82–85% reduction against these measurements.
These are advisory local measurements, not a CI performance gate.

A separate `--filter macro/ --count 5` run measured Load as follows:

| Workload | Bun TS | Zig | TS / Zig |
| --- | ---: | ---: | ---: |
| `macro/game-tick` | 219.4 µs | 18.3 µs | 12.0× |
| `macro/report` | 111.4 µs | 13.0 µs | 8.6× |
| `macro/transform` | 218.5 µs | 17.6 µs | 12.4× |

Every ordinary-suite workload retained its expected output and matched Fuel
across TS and Zig. Raw outputs:
[initial Load](../../bench/results/ts-load-1599/baseline-load.txt),
[Load recheck](../../bench/results/ts-load-1599/recheck-load.txt),
[macro](../../bench/results/ts-load-1599/baseline-macro.txt).

### Load-only profiles

The new [Load-only entry](../../bench/ts/src/measure-load.ts) verifies the workload
once, then profiles five seconds of repeated Load with fresh Groups and Script
names. It excludes the ordinary runner's timed Runs and heap sampling. The
verification and process startup still appear in the CPU profile; verification
accounts for about 2.8% of the large profile's samples. Profiles and timings were
collected separately, with no concurrent tests or benchmark jobs.

| Sampled function, inclusive | Large Load | Small Load |
| --- | ---: | ---: |
| `checkSource` (parse plus checking) | 80.4% | 64.3% |
| `checkParsed` (checking, including its subpasses) | 55.6% | 36.0% |
| `parseSource` | 24.8% | 27.9% |
| `lowerTree` | 14.1% | 12.9% |
| `viewSource` | 8.9% | 7.5% |
| `codeIdentity` | 0.7% | 7.9% |

These are fractions of stack samples, not separately timed phases. Parent and
child rows overlap: `checkSource` includes parsing/checking, and `viewSource`
appears inside lowering and other callers. Do not add these rows as independent
potential savings. Sample counts and attribution are in
[metadata.json](../../bench/results/ts-load-1599/metadata.json); the compressed
[large](../../bench/results/ts-load-1599/large.cpuprofile.gz) and
[small](../../bench/results/ts-load-1599/small.cpuprofile.gz) profiles retain the
call trees and line samples.

The large profile assigns 33.5% self samples to `checkParsed`, spread across
context construction, classification and conversion. Parser lookahead/lexing and
semantic-to-view conversion are also substantial. As an approximate Amdahl
bound, eliminating *all* checker work at the measured mix would still leave
44% of current large Load, well above its 15–18% budget. That is a reason to
include parsing and representation boundaries in scope; it is not proof that
ordinary parser/checker optimization is impossible or that fusion will succeed.

### Rejected checker experiment and Node spot-check

An exploratory patch extracted local checker phases into separate closures,
without changing their algorithms. Three paired fresh-process measurements used
identical Load-only bundles, alternating baseline/trial order between pairs.
mitata chooses the TS sample counts; `--count 5` in the ordinary suite controls
Zig repeats, not mitata samples.

| Workload | Baseline median of medians | Trial median of medians | Change |
| --- | ---: | ---: | ---: |
| small | 39.00 µs | 55.60 µs | 42.6% slower |
| large | 28.21 ms | 23.94 ms | 15.2% faster |

The large improvement leaves the target far away and the small regression
rejects this patch. Function size alone is not a sufficient fix. The
[paired measurements](../../bench/results/ts-load-1599/paired-load.json) retain
sample counts, ranges, expected output, Fuel and logical allocation. The
[archived patch](../../bench/results/ts-load-1599/checker-phase-split.patch.gz)
is experimental evidence, not an applied Core change. Its source hashes are
recorded in metadata.

The same Load-only entry bundled for Node measured **29.71 µs small** and
**44.15 ms large** ([raw spot-check](../../bench/results/ts-load-1599/node-load.json)).
This is a single V8 spot-check, not an improvement claim or a new target baseline.
It confirms that a Bun-specific code-shape change needs independent Node
verification. Both workloads retained output, Fuel and logical allocation.

## Next implementation experiment

Prototype fusion of strict recognition, semantic fact collection and a
lowering-oriented representation. Share the recognizer with the lossless tooling
path; preserve its public syntax/semantic contracts and avoid a second grammar.
Collect declaration/local/capture records and body-call facts while constructing
the representation, then resolve forward references and suspension dependencies
after collection. Begin with the large workload's common expressions and bodies,
but measure the small workload on every change.

The prototype must preserve diagnostics and recovery, unbounded syntax depth,
code identities, instruction/constant/slot ordering, Fuel and Trace. Keep
runtime-neutral Bun/Node/browser code and emit no JavaScript. Validate parser,
checker and lowering tests, disassembly and the Corpus against unchanged
expectations before considering it for integration.

Compare against the unchanged base with alternating ordinary-suite runs using
`--count 5`, plus Load-only stage profiles, macro/tooling measurements and a Node
spot-check. Advance only on repeatable end-to-end improvement on both Load sizes;
meeting 5× remains the issue's final acceptance. If the prototype has little
benefit, retain useful measured local improvements and reassess the target with
that evidence rather than relaxing it now.

Incremental `analyzeWorkspace` can reuse the same facts later, with explicit
invalidation for imports, bindings, contracts, Grants and suspension summaries.
Its edit/reanalyse gains should be reported using `tooling/lsp-reanalyse`, not
substituted for fresh Load results.

## Reproduction

Install and check generated Unicode data before testing on a fresh worktree:

```sh
bun install --frozen-lockfile && bun run unicode:check
bun run bench --only ts,zig --filter lifecycle/load --count 5 --no-save
bun run bench --only ts,zig --filter macro/ --count 5 --no-save
mkdir -p .cache/profiles
bun --cpu-prof --cpu-prof-dir=.cache/profiles bench/ts/src/measure-load.ts lifecycle/load-large profile
bun --cpu-prof --cpu-prof-dir=.cache/profiles bench/ts/src/measure-load.ts lifecycle/load-small profile
bun build bench/ts/src/measure-load.ts --target node --outdir bench/ts/dist
node bench/ts/dist/measure-load.js lifecycle/load
```

For the rejected experiment, build the Load-only entry with `--target bun` into
`bench/ts/dist/baseline-load.js`. Apply the decompressed archived patch at the
recorded base, build `bench/ts/dist/trial-load.js`, then reverse the patch. Run
these two bundles in fresh Bun processes, alternating order per pair. Keep
bundles directly in `bench/ts/dist` so the suite's relative fixture lookup works.
The patch changes only `impl/ts/src/checker.ts`; the profiling checkpoint leaves that file
identical to the base.

## Architecture findings

Source investigation for [#1599](https://github.com/odogono/odgn-talk/issues/1599), 2026-10-27. This source investigation complements the measurements above; source structure alone establishes neither target attainment nor impossibility.

**Current path.** `Group.load` calls `prepare`, which parses/checks against the current Libraries, Grants, Objects and property declarations, checks Library needs, discovers imports, and computes identity. Only afterwards does `loadPrepared` consult the process-wide compiled-Script cache. A hit avoids lowering, but still performs preparation and initialization. On a miss, `lowerTree` converts the semantic tree through `viewSource` and lowers its declarations. These are distinct representations: lossless syntax, semantic nodes/bindings, declaration/expression views, then code. [Group Load](../../impl/ts/src/group.ts#L2236), [prepare](../../impl/ts/src/library.ts#L204), [cache boundary](../../impl/ts/src/group.ts#L2316), [lowerTree](../../impl/ts/src/lowering.ts#L2564), [viewSource](../../impl/ts/src/view.ts#L434).

| Approach | Concrete scope and opportunity | Obligations / limits |
| --- | --- | --- |
| Focused parser/checker changes | Reduce allocation and repeated child selection, context lookup, sorting and tree walks; collect reusable body facts and dependencies while traversing; investigate replacing repeated suspension scans with dependency-driven propagation. Optimize the semantic-to-view boundary independently. | Preserve diagnostics, scope/capture ordering and output. The existing checker already shares traversal context, and `viewSource` already supports selecting declarations: improvements need evidence against these existing optimizations. No source-only speedup estimate. |
| Single-pass compile front end | Fuse recognition with construction of semantic records or a lowering-oriented representation, potentially avoiding full intermediate semantic/view materialization on the compile path. Keep the public lossless tooling tree, either as another output of shared recognition or through a maintained tooling path. | One source scan cannot mean irrevocably finishing every body as it is read. It needs declaration/binding placeholders, deferred checks, graph analysis and code fixups or buffered bodies. Retain explicit stacks, recovery behavior and normative lowering. Larger implementation and parity surface. |
| Incremental reanalysis | Reuse unchanged syntax/body facts and invalidate dependents when imports, contracts, bindings, suspension summaries or manifest context change. Particularly relevant to repeated editor edits. | Requires previous state and reliable invalidation. A genuinely fresh Group Load still must read/check new source and initialize it; an editor cache does not accelerate that path merely by existing. Shared context-aware compile/check caches would be a separate Core change. |

The focused opportunities above are hypotheses grounded in the [checker context/work lists](../../impl/ts/src/checker.ts#L232), [binding ordering](../../impl/ts/src/checker.ts#L881), [post-binding semantic checks](../../impl/ts/src/checker.ts#L1337), [suspension propagation](../../impl/ts/src/suspension.ts#L218), and [view conversion](../../impl/ts/src/view.ts#L455), rather than claims that any particular operation dominates elapsed time.

**Forward declarations and cross-body binding.** The checker collects declarations before resolving reads; function contracts are available for forward-call arity checks. Whole-body locals may be read before their first write. Enclosing scopes and explicit Lambda locals must be completed before deciding whether a Lambda write captures or introduces a local. Constants/default initializers have stricter source-order rules, and Binary Pattern sizes see only already-bound fields. Lowering also builds variable/constant and function/body tables before emitting bodies. Fusion can retain these semantics through deferred records and fixups; removing passes does not remove the dependencies. [Declaration registration](../../impl/ts/src/checker.ts#L846), [Lambda binding/capture resolution](../../impl/ts/src/checker.ts#L894), [sequential Binary bindings](../../impl/ts/src/checker.ts#L1096), [initializer rules](../../impl/ts/src/checker.ts#L1221), [forward/local examples](../../impl/ts/tests/checker.test.ts#L40), [forward-call checks](../../impl/ts/tests/checker.test.ts#L505), [lowering tables](../../impl/ts/src/lowering.ts#L252).

**Suspension is a graph property.** Handler suspension propagates over `and wait` calls to a fixpoint; function reachability has another fixpoint. Imported/existing definitions supply suspension summaries. Final checks cover missing/needless `and wait`, named functions and restricted cleanup/recovery contexts; Decision checking consumes the result. A fused front end can collect compact facts during parsing, then solve dependencies after bindings exist. Fully finalizing checks on leaving the first body is insufficient for later and transitively suspending callees. [Suspension facts and fixpoints](../../impl/ts/src/suspension.ts#L1), [propagation and final diagnostics](../../impl/ts/src/suspension.ts#L218), [imported summaries and Decisions](../../impl/ts/src/checker.ts#L1354).

**Recovery and syntax depth are existing behavior.** Syntax children own each original character exactly once, including trivia, and `syntaxText` reconstructs the source. Recovering parsing preserves failed productions/skipped tokens under `Error`; semantic recovery treats malformed regions as opaque while retaining usable sibling statements. The normative first syntax diagnostic remains distinct from subsequent recovery diagnostics. Parsing uses generator tasks driven by an explicit stack, checking and view conversion use work lists, and lowering uses the task driver. Any new compile/tooling design must preserve absence of a native-call-stack syntax-depth limit; a recursive shortcut would regress established behavior. [Lossless ownership](../../impl/ts/src/syntax.ts#L106), [parser tasks/recovery](../../impl/ts/src/parser.ts#L156), [strict/recovering APIs](../../impl/ts/src/parser.ts#L3367), [semantic recovery](../../impl/ts/src/checker.ts#L149), [task driver](../../impl/ts/src/tasks.ts#L1), [deep-source examples](../../impl/ts/tests/parser.test.ts#L123).

**Identity, Fuel and context constrain reuse and emission.** Code identity includes exact source, language/Cost Model versions, unit kind/name and direct imported identities. The compile key additionally covers resolved Host Commands; extensions include prior identity/slot context. The Abstract Machine specifies exact instructions, slots and constant-pool ordering so Fuel, fault locations and Trace behavior agree. A fused implementation may change internal work but must preserve that output; caching checks must account for Grants, imports, existing names and Object properties, not just source text. No generated JavaScript or runtime-specific solution is within the issue's constraints. [Identity/key](../../impl/ts/src/library.ts#L58), [context inputs](../../impl/ts/src/checker.ts#L37), [extension cache](../../impl/ts/src/group.ts#L2330), [normative lowering/Fuel](../../spec/08-the-abstract-machine-and-the-cost-model.md), [identity contract](../../spec/09-embedding.md#the-pump-and-the-group-fingerprint).

**Why incremental LSP work does not settle fresh Load.** `analyzeWorkspace` currently reuses matching unversioned standard-workspace documents, parses other sources recoveringly, and repeats Library checking until export contracts/suspension summaries stabilize. This is a separate entry point from `Group.load`; incremental workspace dependency tracking could reduce repeated editor analysis without changing Core preparation. It may share useful infrastructure, but fresh-source Load has no prior edit tree to reuse. [Workspace reuse and checking](../../tooling/stack/src/lsp/workspace.ts#L61), [Core preparation](../../impl/ts/src/library.ts#L204).

**Recommendation and objections.** Admit broader parser/checker work now, including collecting shared facts and reducing intermediate representations, before committing to a fully fused single-pass rewrite. Establish stage-specific allocations and end-to-end Load effects for concrete candidates, then use measured results to choose whether deeper fusion is warranted. Objections: local changes may leave too much representation/traversal overhead; shared-fact work can approach rewrite complexity; maintaining two recognition paths risks drift; deferring fusion can duplicate effort if the final design discards those structures. Conversely, a fused scan still owes forward binding, suspension solving and normative output, so calling it “single pass” does not establish a performance outcome. The overlapping profile percentages cannot be added as independent savings or used to prove the 5× target reachable or impossible.

## Validation of this report and harness

- Fresh-worktree dependency installation and Unicode table verification passed.
- `bun test bench/ts/tests/suite.test.ts bench/ts/tests/measurement.test.ts`: 84 passed.
- Benchmark package typechecking, ESLint and Prettier checks passed.
- The Load-only entry ran successfully under Bun and the Node bundle.
- Ordinary TS/Zig Load and macro runs verified expected results and Fuel parity.
- `bun run docs:check` resolved links in all 953 Markdown files; `git diff --check` passed.
- At the profiling checkpoint, the rejected patch was archived only and Core source was unchanged from the measured base.
