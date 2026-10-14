# Five TS Core performance issue scopes

These scopes follow the [four-runner measurements at `f51ad856`](../../bench/results/2026-10-14-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua-after-five-areas-f51ad856.json), on Apple M5, Bun 1.4.3, language 1.0-rc.3 and Cost Model 0. The evidence branch `4cff1568` changes documentation, not the measured TS runtime. Figures are three-sample Run medians, excluding Load. Ratios identify useful workload targets; they do not establish a particular function's CPU share or promise speedups.

| Workload | TS Run ms | TS / native Zig | TS / AppleScript |
| --- | ---: | ---: | ---: |
| `numbers/quantity` | 4.106 | 10.43× | 35.03× |
| `numbers/divide` | 2.169 | 6.03× | 11.43× |
| `text/index` | 7.088 | 10.38× | 8.13× |
| `collections/list-update` | 4.519 | 7.64× | 12.13× |
| `collections/list-append` | 6.832 | 6.70× | 4.87× |
| `collections/list-build` | 1.337 | 5.85× | 5.88× |
| `macro/transform` | 3.055 | 10.04× | 9.19× |
| `core/calls` | 2.737 | 3.93× | 4.60× |

The current implementation already has persistent List growth and incremental logical-size seeds from [#503](https://github.com/odogono/odgn-talk/issues/503), [optimized Script Loads from #505](../../bench/results/2026-10-09-ts-load.md), and [packed Unicode tables from #399](../../bench/results/2026-10-12-ts-unicode-tables.md). It also caches immutable Decimal parts and preserves them directly for arithmetic results, as documented in the [TS guide](../../impl/ts/README.md#public-values). None of the scopes below reopens those completed changes or translates another Core's implementation; the normative constraints come from the shared Spec.

## 1. Read Character chunks without repeatedly materializing the whole Text

**Proposed issue:** `perf(ts): Avoid repeated Character segmentation in chunk reads`.

[`operations.chunkGet`](../../impl/ts/src/operations.ts) calls `spans`, which constructs all Characters and spans. It then calls `characters(s).length` to count input units; successful reads call `joinSpans`, which constructs Characters again before slicing the selected range. [`text.characters`](../../impl/ts/src/text.ts) builds a full boundary array and one string per Character. The indexing workload repeatedly reads from the same short ASCII literal. Packed Unicode tables already improved lookup cost in #399; this issue removes repeated traversal/materialization above those tables.

The [current Bun profiles](../../bench/results/2026-10-14-ts-performance-profiles.json) attribute 37.9% of indexing Pump samples to text/chunk stacks and an overlapping 34.6% to grapheme segmentation. `characterBoundaries` alone is the largest exclusive leaf (708 of 2,090 Pump samples). This supports Character reads as the first target.

Use one boundary/count pass per read first, then investigate a direct forward read for positive Character indexes, an ASCII path or bounded reusable boundary metadata. Positive indexing may stop native work after finding the requested end while still reporting precisely the specified `scanned`; negative and out-of-range reads may require full length. Extend only where measured to word/item/line reads that share this path. Keep Text construction and NFC behavior correct.

Preserve CRLF as one Character, extended grapheme clusters, negative and ranged indexes, empty/out-of-range results, delimiter behavior and exact scanned Fuel in [chunk rules](../../spec/04-expressions-and-statements.md#chunk-expressions). Fixed-index probes should remove modulo/equality work from the benchmark, and a text-length sweep should include reads near the beginning/end and negative indexes. Use Unicode/operation tests and text corpus cases; no Unicode table format rewrite is needed.

## 2. Reuse Unit conversion metadata and ordered factor plans

**Proposed issue:** `perf(ts): Reuse Unit descriptors and conversion plans`.

[`units.ts`](../../impl/ts/src/units.ts) already parses generated numeric factors once at module initialization. It still builds fresh `top`/`bottom` arrays in `factorsOf` for each `toBase` and `fromBase`. `sameDimension` reconstructs a Map, splits dimension strings, sorts and joins a signature for both operands. `combine` clones/sorts Unit slots. [`operations.convertToUnit`](../../impl/ts/src/operations.ts) parses and prints the static target on every `as m` execution in the [Quantity workload](../../bench/scripts/numbers/quantity.talk), while arithmetic repeatedly derives Units and converts through Base Units.

The [Quantity profile](../../bench/results/2026-10-14-ts-performance-profiles.json) attributes 41.9% of Pump samples to Unit stacks, with `factorsOf` alone 8.2% exclusively. Decimal work is an overlapping 31.4%; Unit and numeric percentages must not be added.

Prepare static verified conversion targets once per code unit and reuse immutable metadata for dimensions and ordered factor sequences. Determine whether descriptor identity or bounded caching can also reuse combinations; preserve ownership of frozen Unit slots across public constructors, reload and restore. This issue targets metadata/traversal and allocation overhead. Issue 5 targets numeric execution of each factor, so benchmark each separately.

Retain every prescribed factor operation and its rounding in order; multiplying factors together can change results. Even factor one can alter the nearest ideal exponent for a noncanonical cohort, so an identity shortcut requires proof against [Unit and Number rules](../../spec/03-values.md). Preserve ratio Units, calendar restrictions, incompatible dimensions, empty Units, display and encoding. Bound any retained cache; do not keep arbitrary conversion strings globally forever. Use [Quantity tests](../../impl/ts/tests/quantities.test.ts), Quantity/conversion cases and repeated Run measurements.

## 3. Specialize charging and leaf logical-size accounting

**Proposed issue:** `perf(ts): Specialize common charges and scalar logical sizes`.

[`costs.ts`](../../impl/ts/src/costs.ts) interprets generated formula terms for charges and logical sizes. `sizeOf` maintains WeakMap caches and correctly visits shared values once, but every uncached scalar still creates `pending`, `order` and `seen` containers, calls `childrenOf` (returning an empty array), and evaluates the general size formula. Every newly constructed integer/arithmetic result can encounter that path. `cacheListExtension`/`cacheListEdit` seed collection sizes incrementally; they still measure newly added scalar Values. The `[measure, subject, factor, divisor]` evaluation is another crosscutting candidate.

The [fresh profiles](../../bench/results/2026-10-14-ts-performance-profiles.json) show accounting stacks at 28.8% of transform Pump samples, including an overlapping 20.3% for logical sizes; List append accounting is 20.9%, with logical sizes 9.3%. These are stronger measured targets than List storage itself in those workloads.

Compile fixed and common rates from the authoritative generated Cost Model, and provide exact leaf-size paths derived from the same source. Preserve the general DAG traversal for containers and uncached composite Values. This issue owns accounting overhead; issue 4 owns constructing the numeric Values accounting measures. Do not claim a full List performance win merely because accounting occurs within append/update stacks.

Maintain logical size as if shared subvalues occurred at every Script-visible position, while native traversal visits each distinct node once. Preserve exact ceil formulas, all dynamic measures, Built-in overrides, partial-result/refused operation charges, Persistent State, snapshots, recovery and instruction-by-instruction fault/preemption boundaries in [chapter 8](../../spec/08-the-abstract-machine-and-the-cost-model.md). Generated code must be updated through its generator; no manually maintained second Cost Model. Test all rates against the current evaluator plus shared-DAG size cases and Run accounting, then measure numeric, calls, List, text and sliced execution separately.

## 4. Avoid reparsing integer-range state and validating internal numbers as Host input

**Proposed issue:** `perf(ts): Reduce range iterator and internal numeric construction overhead`.

[`machine.iteratorItem`](../../impl/ts/src/machine.ts) extracts the range start on every `Next` with `source.asRange().from.asDecimal().toString().split('.')[0]` and `BigInt`. It then calls `dec(String(start + BigInt(at - 1)))`, formatting the new integer and sending it through the public input constructor. [`values.dec`](../../impl/ts/src/values.ts) performs input validation/canonicalization and creates a Decimal/Value; its whitespace trimming calls `characterBoundaries` even for these internally generated ASCII digits. [`operations.integerValue`](../../impl/ts/src/operations.ts) already offers an internal checked result path. The iterator source remains immutable, so rereading its start does not discover new state. The [calls](../../bench/scripts/core/calls.talk) and [List update](../../bench/scripts/collections/list-update.talk) workloads both use integer-range loops.

The [fresh profiles](../../bench/results/2026-10-14-ts-performance-profiles.json) attribute 22.8% of calls Pump samples and 17.9% of List-update samples to numeric construction. `iteratorItem` is an overlapping 6.3% and 6.1%, respectively. These construction categories include arithmetic results as well as range items, so removing range reparsing cannot claim to remove the entire constructor share.

Read the range start from its already-cached Decimal parts once or cheaply without string conversion, and build each internally proven integer through the internal constructor path. Keep derived start state ephemeral or rebuild it from the saved source/position on restore; retain the canonical save format. Existing cached Decimal parts already avoid arithmetic reparse, so do not reopen that change. Eager `canonicalNumber` formatting and object freezing are further construction costs to measure, but no removal of public immutable wrappers or unchecked Host input should be bundled into this issue.

Preserve integer-range validity, empty/reversed ranges, signed starts, bounds and index progression, exact Number output/trailing zeros, Fuel per `Next`, allocation and pending cleanup size. The source Value and iterator position must remain meaningful in Inspect, snapshots, preempted/suspended frames and restore. Keep public `dec` validation unchanged. Use [Decimal cache tests](../../impl/ts/tests/decimal-cache.test.ts), range/iterator corpus cases and save/recovery tests, including negative starts and repeated Runs. Establish paired improvements on calls, List update, collecting, transform and numeric workloads, with GC/heap effects reported separately.

## 5. Avoid general rounding work for exact Decimal division, `div` and `mod`

**Proposed issue:** `perf(ts): Add exact Decimal division and integer-operation paths`.

[`decimal.ts`](../../impl/ts/src/decimal.ts) already gives addition and multiplication an `exact` shortcut. Division always calls `result`, including terminating division by eight in the [division workload](../../bench/scripts/numbers/divide.talk). Integer `div` sends its quotient through `signed`/`result`; `mod` realigns operands inside `quotient` after already aligning them, then also calls `signed`/`result`. The general result path formats BigInts for digit counts, repeatedly computes rounded candidate coefficients and finds trailing zeros. These are concrete remaining operations; the profiles below locate Decimal costs without isolating each operator's removable work.

The [current profiles](../../bench/results/2026-10-14-ts-performance-profiles.json) attribute 31.4% of Quantity Pump samples and 15.6% of indexing samples to Decimal execution, inclusively. `result` is prominent in both captures, supporting the general-rounding target. The numeric categories include all Decimal operations and cannot isolate the gain available from division/remainder alone.

Scope the issue to exact terminating quotient paths and already-bounded integer/remainder results, with the existing general rounded path as fallback. Avoid reimplementing the completed exact addition/multiplication paths or replacing Decimal arithmetic with floating point. Cover Quantity division and `i mod 16` in [Character indexing](../../bench/scripts/text/index.talk) as broader checks, without claiming the entire Quantity or indexing gap belongs to Decimal.

Preserve the 34-digit half-even rule, minimum exponent, overflow/division-by-zero errors, operator ideal exponent, cohort/trailing-zero output and negative quotient/remainder semantics in [Number rules](../../spec/03-values.md). Measure terminating and nonterminating inputs, exact boundaries, subnormals and signed operands. Validate output, Fuel and logical allocation with [Decimal cache tests](../../impl/ts/tests/decimal-cache.test.ts), Value tests and numeric corpus cases.

## Measurement gate

The [fresh Bun profiles](../../bench/results/2026-10-14-ts-performance-profiles.json) use Bun 1.4.3 at its default 1 ms CPU sample interval: 20 warm-up Runs followed by three seconds of repeated validated full-size Runs. The profile starts at process startup, but attribution uses only `Loaded.run`/the inlined suite `pump` stacks, excluding Load and setup. Pump attribution includes validation and warm-up as well as steady repeats. The raw compressed profiles and hashes are retained. These captures run separately from comparison timing.

| Priority | Scope | Current sampled evidence |
| --- | --- | --- |
| 1 | Character chunk reads | Indexing text/chunk 37.9%, overlapping graphemes 34.6% |
| 2 | Unit metadata and factor plans | Quantity Unit 41.9%, exclusive `factorsOf` 8.2%; overlapping Decimal 31.4% |
| 3 | Charging and logical sizes | Transform accounting 28.8%, logical sizes 20.3%; List append accounting 20.9%, logical sizes 9.3% |
| 4 | Range iterator/numeric construction | Calls construction 22.8%, iterator 6.3%; List update construction 17.9%, iterator 6.1% |
| 5 | Exact Decimal division/remainder | Quantity Decimal 31.4%; indexing Decimal 15.6% |

Inclusive categories overlap and must not be added. JIT inlining limits named attribution, and GC sampled outside Pump is excluded: these are CPU sample shares, not complete wall-time/GC shares or projected speedups. The current List-storage category is 3.8% of List update, 7.2% of List append and 5.1% of transform Pump samples. Together with source evidence that #503 already avoids repeated whole-spine growth, this supports targeting accounting and numeric construction before another generic persistent-List rewrite. Scalar replacement's endpoint searches, tiny append array allocations and sequential tree indexing remain lower-priority source opportunities; these profiles do not make them the best new issue scope.

The comparison uses natural language ports under the [peer policy](../../bench/README.md#peer-languages). AppleScript's Quantity port applies numeric factors, rather than first-class Units; TS/Zig share the NorthTalk rules and exact Fuel. Use paired TS-before/TS-after timings to establish an optimization's benefit. The three-sample TS medians have visible spread (List update minimum 2.852 ms versus median 4.519 ms), so a gap is prioritization evidence, not a reproducible function-level cost estimate.

For each issue, save alternating paired timings with identical output, Fuel and logical allocation, capture profiles/heap data separately, and run focused checks plus the relevant corpus/lifecycle gates. Keep existing expected records and save formats; optimize native work without relaxing sandbox, immutable-value or Unicode semantics.
