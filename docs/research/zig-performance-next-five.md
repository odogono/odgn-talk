# Next Zig performance priorities after the first five areas

At `f51ad856`, the [four-runner comparison](../../bench/results/2026-10-14-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua-after-five-areas-f51ad856.md) leaves the largest AppleScript gaps in `core/loop` (5.66×), `numbers/quantity` (3.36×), `numbers/add` (2.25×), multiplication (1.90×), division (1.89×), and List point writes (1.59×). These are workload ratios, not estimates of any proposed optimization's gain. All proposals below retain native `safe` mode, exact Decimal semantics and the current Cost Model.

The earlier work already delivered exact bounded division/`div`/`mod` and pre-parsed numeric Unit factors ([#923 measurements](../../bench/results/2026-10-14-zig-division-paths.md)), amortised List growth and removal of a redundant point-write spine ([#924 measurements](../../bench/results/2026-10-14-zig-list-paths.md)), operand-buffer reuse ([#925 measurements](../../bench/results/2026-10-14-zig-operand-storage.md)), bounded frame-buffer reuse ([#926 measurements](../../bench/results/2026-10-14-zig-call-storage.md)), and direct Character indexing ([#927 measurements](../../bench/results/2026-10-14-zig-character-indexing.md)). The five proposals target work those changes leave behind.

## 1. Compile common Cost Model formulas

[`chargeInstruction`](../../impl/zig/src/machine/costs.zig) already resolves opcode-to-rate lookup at compile time. However, `chargeRate` still interprets both Fuel and allocation term arrays through `evaluate`: every term selects a subject and measure, multiplies by a factor, and performs rounded division by its divisor. Even fixed-charge `load`, `store`, branch and jump instructions pass through this general evaluator. Arithmetic charges also compute coefficient digit counts through repeated `u128` division by ten.

Generate specialized evaluation for fixed charges and common numeric rates from the existing authoritative tables; retain a general path for uncommon formulas and dynamic Built-ins. Do not manually maintain a second Cost Model. Reducing the native work of calculating the same charge can help essentially every benchmark, including the loop's two additions and comparison. This is a follow-up to the static rate lookup and operand storage work, with a different mechanism.

The [current CPU samples](../../bench/results/2026-10-14-zig-next-five-profiles.json) attribute 19.5% of loop Pump samples, 20.0% of addition samples, 17.0% of calls and 13.0% of Quantity samples to charging. Formula evaluation alone accounts for 15.8% of loop and 16.2% of addition samples, supporting this as the first target. These are inclusive sampled costs, not removable percentages or promised gains.

The acceptance gate is identical Fuel and logical allocation for every generated rate, missing subject, restricted refusal, Built-in override, Host extra charge and failed-result case. Preserve instruction-by-instruction charging, preemption and fault boundaries in [chapter 8](../../spec/08-the-abstract-machine-and-the-cost-model.md). A reduced charge formula must not become batched charging across observable boundaries.

## 2. Reuse Unit descriptors and ordered conversion plans

[`convert.convert`](../../impl/zig/src/machine/convert.zig) still calls `Unit.parse(target)` on each Unit conversion, even for the same static `as m` target on every iteration of the [Quantity Script](../../bench/scripts/numbers/quantity.talk). The parser searches generated Unit names and builds a full slot array. [`Unit.compatible`](../../impl/zig/src/units.zig) reconstructs dimension vectors, and `convert` visits all Kind slots in two phases. Methods and [`Value.arithmetic`](../../impl/zig/src/value.zig) also pass/copy full Unit-bearing payloads by value in source; determine how much of that survives optimization from current assembly and samples.

Prepare verified static target descriptors once at Load, then investigate bounded reuse of dimension signatures, Unit combinations and **ordered** conversion steps. Small pointer/interface changes could avoid copies before considering any larger representation change. This is distinct from #923's pre-parsed numeric factors: descriptor parsing, dimension derivation and traversal remain.

In the [current Quantity capture](../../bench/results/2026-10-14-zig-next-five-profiles.json), Unit conversion accounts for 22.4% of Pump samples; Unit parsing is 2.4%, and combination is 3.7%. The categories are inclusive and must not be added. The 22.4% conversion share gives ordered conversion plans a stronger measured case than merely caching target parsing. No named dimension samples appear in this capture, so dimension-signature reuse remains a source-based hypothesis.

Keep each specified multiply/divide operation and its rounding in the same order. A conversion plan is an ordered list of existing operations, not a combined factor: algebraically collapsing factors can change Decimal results. Preserve ratio Units, calendar restrictions, exponent bounds, empty Units, comparison-only unbounded intermediates and all allocation refusal paths. Any retained cache must be bounded, physically accounted and invalidated appropriately across reload/restore; [the Unit rules](../../spec/03-values.md) and [`units.zig`](../../impl/zig/src/units.zig) own those contracts.

## 3. Construct scalar Values with less memory traffic

[`model.scalar`](../../impl/zig/src/value.zig) accepts the whole `Data` union by value, calculates ownership rank and assigns a whole `Value`. The Number, Boolean and Nothing variants have small active payloads, but the inline Quantity determines the union's storage. The [current `f51ad856` safe-build disassembly](../../bench/results/2026-10-14-zig-next-scalar-disassembly.txt) shows 368-byte undefined-storage poison initialization followed by a 304-byte `memcpy` of the union; the Mach-O indirect symbol table identifies the called stub as `memcpy`. The existing node cache eliminates most parent allocation requests; it does not eliminate constructor initialization and retain/release traffic.

Prototype narrow Number/Boolean/Nothing constructors that initialize required headers and only the active payload while retaining the existing Value layout and ownership. Verify the changed generated safe-build assembly before claiming reduced copying; compiler inlining and undefined-storage poisoning may affect the result. The timing benefit remains a hypothesis until paired measurements support it.

Current named scalar-construction stacks account for 3.5% of loop samples, 5.1% of addition and 5.4% of calls in the [fresh profiles](../../bench/results/2026-10-14-zig-next-five-profiles.json). Inlined initialization may be attributed to its caller, but these captures do not justify predicting a large scalar-constructor speedup.

Do not simply repeat the boxed-Quantity experiment: that [rejected prototype](../../bench/results/2026-10-14-zig-call-storage.md#compact-value-experiment) produced modest scalar gains but added 1,000 parent Quantity payload requests per Quantity Run. This proposal keeps Quantity inline. It must preserve all defined fields, allocator refusal/atomicity, acyclic ranks, release behavior, physical memory admission and logical sizes. Measure arithmetic, calls, Quantities and small Fuel Slices separately.

## 4. Allow provably unique local List point writes to reuse storage

[#924's report](../../bench/results/2026-10-14-zig-list-paths.md#implementation-and-limits) explicitly leaves one whole visible-spine copy per machine point write. [`chunks.set`](../../impl/zig/src/machine/chunks.zig) deliberately retains its borrowed root before calling `listSet`; this forces the copying branch. Dropping that retain alone would mutate lowering temporaries, real aliases or rollback state. [`listSet`](../../impl/zig/src/value.zig) already has an in-place branch for unique storage, matching allocators and strictly lower-ranked inserted children, but the current machine path cannot use it.

The next seam is ownership-aware execution for a local update whose previous temporary references are proven dead. [`lower.Frame.write`](../../impl/zig/src/lower/lower.zig) stores roots and intermediate wholes in local temporaries; its final `release` merely marks compile-time slot availability and emits no runtime clearing. The ordinary `.load` retains the Value again. This can keep old List versions alive beyond the statement until a slot is overwritten or the frame ends.

Investigate consuming or retiring only provably dead temporary owners before the write, while retaining true Script-visible aliases and Segment rollback roots. Any internal execution specialization must preserve the canonical abstract instructions, source positions, save/restore meaning and Fuel. In the [shared List benchmark](../../bench/scripts/collections/list-update.talk), the first write must preserve `original`; later versions could become unique once artificial holders are removed. That is a candidate, not a claim that all immutable updates can be in-place.

The [current List-update profile](../../bench/results/2026-10-14-zig-next-five-profiles.json) attributes 6.7% of Pump samples to `chunks.set` and an overlapping 5.4% to `listSet`. Broader List costs also include shared release and allocator work; their total samples do not establish how much this proposal removes. The small eight-item benchmark makes a length sweep particularly important.

Measure a List-length sweep and separately probe aliased, unique, nested/rank-raising, padded/range and foreign-allocator writes. Preserve retained versions, hidden-tail acyclicity, failed writes and error cleanup, and Script Variable rollback. If proving uniqueness at this seam is too invasive, a persistent spine is a separate design option that needs its own memory and performance evidence.

## 5. Compare common Decimals directly

[`Decimal.order`](../../impl/zig/src/decimal/decimal.zig) formats **both** coefficients to decimal strings before comparing magnitudes and padded digits, including when their exponents match. The [loop Script](../../bench/scripts/core/loop.talk) repeatedly compares small integral values with equal exponents. The same primitive serves Value ordering and equality, range/iterator logic and other comparisons through [`value.zig`](../../impl/zig/src/value.zig).

Add exact equal-exponent coefficient comparisons, sign/zero shortcuts, and checked bounded scaling for unequal exponents where possible. Keep the current padded-digit method as a fallback for huge exponent gaps. This targets comparisons, distinct from the arithmetic operations already optimized. A coefficient-digit helper may be shared with charging, but measure the two optimizations separately to establish their effects.

The [current loop profile](../../bench/results/2026-10-14-zig-next-five-profiles.json) attributes 3.3% of Pump samples to `Decimal.order`. This is a concrete, narrow optimization with a modest measured footprint, which places it fifth. Decimal comparison alone does not explain the 5.66× AppleScript gap.

Keep equality across alternate Decimal cohorts (`1`, `1.0`, `1.00`), signed values, zero and exponent extremes correct. No float conversion or changed rounding is needed; comparisons must neither allocate a new scalar nor lose exact order. The authority is [Number comparison](../../spec/03-values.md).

## Evidence and limits

The [fresh `f51ad856` profiles](../../bench/results/2026-10-14-zig-next-five-profiles.json) use separate two-second CPU captures at 1 ms intervals on the current native safe-mode host. The host schedules 300 validated Run samples and is deliberately terminated after capture, before Load. Only `talk_pump` stacks enter the denominator (1,527–1,531 samples per workload). The comparison supplies timing; profiling does not overlap the timing runs. Binary and raw-report hashes are retained in the JSON, alongside compressed call trees.

| Priority | Mechanism | Current sampled evidence |
| --- | --- | --- |
| 1 | Specialized charge formulas | Charging: loop 19.5%, addition 20.0%, calls 17.0%, Quantity 13.0%; formula evaluation alone: loop 15.8%, addition 16.2% |
| 2 | Unit descriptors and ordered plans | Quantity: conversion 22.4%, parsing 2.4%, combination 3.7% |
| 3 | Narrow scalar constructors | Construction: loop 3.5%, addition 5.1%, calls 5.4%; inline work may appear under callers |
| 4 | Ownership-aware local List writes | List update: `chunks.set` 6.7%, overlapping `listSet` 5.4%; release/allocator work also remains |
| 5 | Direct exact Decimal comparisons | Loop: `Decimal.order` 3.3% |

Percentages are inclusive, overlap and must not be summed. Historical sample percentages cannot be transferred to this revision. The large `Group.execute` and `Group.instruction` exclusive leaves include inlined instruction behavior, safety and accounting checks as well as dispatch; they are not evidence that their whole cost can be removed by changing dispatch. Sampled costs locate work but do not predict an unimplemented optimization's speedup.

The [peer policy](../../bench/README.md#peer-languages) permits each language's natural port. The [AppleScript loop](../../bench/peers/applescript/core/loop.applescript) uses a counted loop, whereas NorthTalk explicitly checks and increments its counter. AppleScript's [Quantity port](../../bench/peers/applescript/numbers/quantity.applescript) applies numeric factors rather than constructing first-class Units. Those comparisons motivate user-workload performance work without isolating equivalent instruction or numeric kernels.

Before accepting an optimization, collect alternating paired native timings and separate profiles/allocation probes from the same revision, preserving output, exact Fuel and logical allocation. Run the affected correctness/refusal cases and the required broader corpus/lifecycle checks for ownership or machine changes. A source opportunity is sufficient to justify a prototype; it is not sufficient to claim its speedup.
