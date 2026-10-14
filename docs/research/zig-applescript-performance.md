# Zig performance priorities against AppleScript

The [focused 2026-10-14 comparison](../../bench/results/2026-10-14-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua.md) measures native Zig in `safe` mode, its C Host at `-O2`, on an Apple M5. Ratios below are calculated from the full-precision Run medians in the [raw JSON](../../bench/results/2026-10-14-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua.json). Zig wins 7 of the 21 workloads shared with AppleScript; the geometric mean of Zig/AppleScript Run time is 1.127. This is a limited three-repeat comparison, not a statistical claim about every Script.

## Ranked areas

| Priority | Area | Workloads | Zig / AppleScript Run time |
| --- | --- | --- | --- |
| 1 | Decimal division and Unit conversion | `numbers/quantity`, `numbers/divide` | 10.661×, 5.007× |
| 2 | Collecting and List item writes | `collections/list-build`, `collections/list-update`, `macro/transform` | 3.442×, 2.144×, 2.046× |
| 3 | Operand-state initialization and instruction accounting | `core/loop`, `numbers/add`, `numbers/multiply` | 7.419×, 2.971×, 2.529× |
| 4 | Call-frame and scalar Value storage | `core/calls`, `core/fib`, `core/lambdas`, `macro/game-tick` | 1.533×, 1.968×, 1.920×, 1.282× |
| 5 | Text indexing without repeated full segmentation | `text/index` | 1.771× |

These are priorities for investigation and prototypes. The measured timing gaps do not predict how much a particular change will save.

The [current CPU samples](../../bench/results/2026-10-14-zig-applescript-profiles.json) use the same native safe-mode Core, sampling repeated validated Runs for two seconds at 1 ms intervals. Timing and profiling are separate. Percentages below use only stacks under `talk_pump`, excluding Load and Host work. Inclusive categories overlap; compiler inlining limits named attribution. The JSON links the compressed raw call trees and records binary/report hashes.

### 1. Decimal division and Unit conversion

The current [Decimal implementation](../../impl/zig/src/decimal/decimal.zig) has checked `u128` exact paths for addition, subtraction and multiplication. Division, `div` and `mod` still enter `calculateGeneral`, constructing managed big integers and passing through `finish` for rounding/exponent selection. The [division workload](../../bench/scripts/numbers/divide.talk) repeatedly divides by 8, so a bounded exact terminating-division path is a concrete first target. Integer `div`/`mod` fast paths also deserve investigation: [text indexing](../../bench/scripts/text/index.talk) uses `i mod 16` on every iteration.

[Unit conversion](../../impl/zig/src/units.zig) repeatedly parses generated factor strings with `Decimal.parse`, visits the Unit slots in two phases and performs Decimal multiplication/division for each factor. [Quantity arithmetic](../../impl/zig/src/value.zig) converts through Base Units; there are also factor-one operations in ordinary canonical Units. Investigate pre-parsed factor constants and exact identity/terminating-conversion paths. Preserve the specified conversion order, rounding at every step and trailing zeros in [the numeric and Quantity rules](../../spec/03-values.md); collapsing factors without proof can change results.

The current profiles attribute 979/1,493 Quantity Pump samples (65.6%) and 823/1,492 division samples (55.2%) to Decimal arithmetic; Unit conversion is an overlapping 48.0% of Quantity samples. This supports the first priority. The [earlier Decimal measurements](../../bench/results/2026-10-14-zig-decimal-paths.md) already demonstrated 2.40× faster addition and 3.02× faster multiplication, with multiplication's sampled managed-integer work largely disappearing. Reimplementing those paths would target work already removed.

### 2. Collecting and List item writes

There is a direct algorithmic opportunity in [instruction execution](../../impl/zig/src/machine/machine.zig): `.list_append`/`.list_extend` copy the whole previous List into a temporary `ArrayList`, append, then call `model.list`, which copies the spine again and retains all children. Both [list construction](../../bench/scripts/collections/list-build.talk) and [invoice transformation](../../bench/scripts/macro/transform.talk) use `collecting`, so repeated growth retains quadratic copying.

Ordinary `.append`/`.append_all` already use the spare-capacity, shared-storage `listGrow` path in [Value storage](../../impl/zig/src/value.zig). Reuse that machinery for collecting, while preserving retained versions, ownership ranks, allocation refusal and physical caps. Then examine [chunk item writes](../../impl/zig/src/machine/chunks.zig): they likewise construct a temporary whole-List copy followed by `model.list`, whereas `value.zig` already has a copy-on-write `listSet` helper. The [List update workload](../../bench/scripts/collections/list-update.talk) retains the original, so any change must preserve its first item.

The [current construction profile](../../bench/results/2026-10-14-zig-applescript-profiles/collections-list-build.txt.gz) attributes 41.9% of Pump samples to `value.list` inclusively and 14.5% to `release` exclusively. This corroborates the copying/retention target without predicting the unimplemented change's speedup. Use a size sweep and allocation probes to establish that. [Earlier allocation measurements](../../bench/results/2026-10-14-zig-value-allocations.md) likewise identified retained nodes and List-buffer copying as costs the node cache does not remove.

### 3. Operand-state initialization and instruction accounting

The strongest new execution finding is copying of `Operands`, the eight-slot temporary state in [the run loop](../../impl/zig/src/machine/machine.zig). It is initialized for every instruction and assigned `o.* = .{}` again on release, including when no protected operands were retained. The [native disassembly](../../bench/results/2026-10-14-zig-execute-disassembly.txt) shows two 416-byte `memcpy` calls to the same stack location; their attribution to `held` initialization and `Operands.release` is inferred from the layout and source. Current profiles attribute 198/1,511 loop samples (13.1%) and 216/1,499 call samples (14.4%) to memory moves at those two `Group.execute` sites. Investigate separating initialized metadata from the unused buffer, or initializing it only when required, while keeping native safe mode.

Charging accounts for another 256/1,511 loop samples (16.9%); scratch reset accounts for 111 (7.3%), with categories overlapping. Opcode-to-rate lookup already landed, as [the earlier bookkeeping measurements](../../bench/results/2026-10-14-zig-instruction-bookkeeping.md) document. Common-charge specialization and reduced scratch work are followups to measure. Preserve exact Fuel, preemption, cancellation, cleanup and fault boundaries in [the machine rules](../../spec/08-the-abstract-machine-and-the-cost-model.md); these profiles do not justify removing operand protection.

The 7.419× loop gap is a useful broad target, but [NorthTalk's port](../../bench/scripts/core/loop.talk) is an explicit `repeat while` with two additions and a comparison, whereas [AppleScript's port](../../bench/peers/applescript/core/loop.applescript) uses a native counted loop with one explicit addition. It does not isolate dispatch performance instruction for instruction.

### 4. Call-frame and scalar Value storage

[`pushFrameIn` and `popFrame`](../../impl/zig/src/machine/machine.zig) allocate/free local slots and operand-stack storage per call, with fresh Nothing Values for unused locals. The [Value allocation report](../../bench/results/2026-10-14-zig-value-allocations.md) identified untouched per-call allocation sizes of 144 and 24 bytes, with about 2,000 requests each in `core/calls`. The current call profile attributes 182/1,499 Pump samples (12.1%) to allocator work inclusively. Investigate reusable frame/local-slot storage, preserving retained caller state, recursion, errors and allocator refusal.

Compact scalar Values are a later representation candidate. [The tagged union](../../impl/zig/src/value.zig) carries a full inline Quantity/Unit payload even for Boolean/Number nodes. The allocation report measured 368-byte nodes, dominated by the 256-byte Unit. The [existing node cache](../../impl/zig/src/machine/group_allocator.zig) reduced loop parent requests from 6,027 to 25, yet was effectively timing-neutral with the default allocator (geomean ratio 0.992). Smaller nodes or internal unboxed scalars might reduce initialization/reference traffic, but that gain remains unproven and needs a prototype across arithmetic, calls and Quantities.

The subsequent [call-storage measurements](../../bench/results/2026-10-14-zig-call-storage.md) isolate #926 against the post-#923 revision. Bounded reuse of released locals and operand buffers reduces `core/calls` parent requests from 4,028 to 29, with about a 1–2% observed timing shift on the target workloads. Ownership, physical-cap eviction and retained capacity are documented in the [current Zig guide](../../impl/zig/README.md); fresh four-runner comparisons still show residual AppleScript gaps.

Those measurements also archive a boxed-Quantity prototype with 128-byte nodes. It modestly reduces scalar construction traffic and default timings, but adds 1,000 parent payload requests per Quantity Run. The representation rewrite is rejected for this patch; Value nodes remain 368 bytes. The linked report includes the prototype patch, generated constructor assembly, memory probes and timing uncertainty.

### 5. Text indexing without repeated full segmentation

[Chunk reads](../../impl/zig/src/machine/chunks.zig) build Characters, span arrays and count arrays for the entire Text before selecting one Character. The [index workload](../../bench/scripts/text/index.talk) repeatedly indexes the same short ASCII literal, making a direct ASCII/one-Character path or reusable segmentation a concrete candidate. Preserve CRLF grapheme behavior, negative indexes, empty/out-of-range results and the precise `scanned` Fuel input. Any cache needs bounded, physically accounted storage.

The workload also performs `mod`, addition and equality. The [current profile](../../bench/results/2026-10-14-zig-applescript-profiles/text-index.txt.gz) attributes 523/1,499 Pump samples (34.9%) to Decimal work, 21.5% to chunk segmentation and an overlapping 18.4% to grapheme work. Numeric fast paths therefore also address this row. Text iteration and pattern matching already beat AppleScript by 4.588× and 24.328× respectively in [this comparison](../../bench/results/2026-10-14-darwin-arm64-apple-m5-zig-ts-applescript-gopher-lua.json), so broad Unicode/pattern rewrites have a weaker case for this goal.

## Reading the comparison

The [suite's peer policy](../../bench/README.md#peer-languages) deliberately uses each language's idioms and native numeric types, while NorthTalk keeps Decimal numbers, immutable Values, Fuel and sandbox bookkeeping. In particular, [NorthTalk's Quantity port](../../bench/scripts/numbers/quantity.talk) executes first-class Unit arithmetic, while [AppleScript's port](../../bench/peers/applescript/numbers/quantity.applescript) applies numeric factors. Those are useful user-workload targets, but the 10.661× ratio does not isolate equivalent numeric kernels.

Keep native `safe` mode, output, exact Fuel and logical allocation fixed for paired comparisons. Profile separately from timing, include size scaling for collecting, and test allocation refusal and retained versions when storage changes. The CPU samples establish where the current workload spends time; they cannot establish an unimplemented optimization's speedup.
