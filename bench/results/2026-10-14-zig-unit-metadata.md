# Zig Unit metadata measurements (#936)

Apple M5, Darwin arm64, native Zig 0.17.0 `safe`, C Host `-O2`,
language 1.0-rc.3 and Cost Model 0. Baseline is `f51ad856` (current main at
intake); the candidate is the working tree identified by the source and binary
SHA-256 values in [paired data](2026-10-14-zig-unit-metadata.json).

The baseline was built and measured before editing. Final timings use three
alternating before/after pairs, five samples per process, with compilation and
CPU sampling outside the timing run. Each process checks its output; separate
counting-allocator probes assert identical Fuel and logical allocation. Load
and Run timings are separate. The broader selection covers every supported
manifest workload and the Fibonacci Fuel Slice sweep, plus division, conversion,
compound conversion, ratio conversion and comparison probes.

## Paired timings and physical copies

Medians of the three process medians, milliseconds per checked Run:

| Workload | Before ms | After ms | Speedup |
| --- | ---: | ---: | ---: |
| `numbers/quantity` | 0.397 | 0.310 | 1.28× |
| `probe/conversion` | 0.632 | 0.494 | 1.28× |
| `probe/compound-conversion` | 0.705 | 0.506 | 1.39× |
| `probe/ratio-conversion` | 1.766 | 1.538 | 1.15× |
| `probe/comparison` | 0.620 | 0.522 | 1.19× |
| `numbers/add` | 0.504 | 0.504 | 1.00× |
| `numbers/multiply` | 0.331 | 0.323 | 1.02× |
| `numbers/divide` | 0.361 | 0.352 | 1.02× |
| `probe/div` | 0.334 | 0.324 | 1.03× |
| `probe/mod` | 0.334 | 0.326 | 1.03× |
| `probe/divide-repeating` | 1.162 | 1.159 | 1.00× |

All 38 workload/slice selections preserve output, Fuel and logical allocation.
The wider suite is largely within a few percent; the Fibonacci slice-100 row
is 1.225 → 1.255 ms (2.4% slower), while the other Fibonacci slices are neutral
or faster. These small changes are not claimed as Unit improvements.
Quantity Load is about 8.31 → 8.42 µs: preparing metadata has a small Load cost.

The separate Quantity allocation probe keeps 29 allocator requests and changes
requested Run bytes from 13,388 to 12,604; held Group bytes fall 12,462 → 11,006
and the Group peak 31,288 → 30,728. Fuel remains 14,579 and logical allocation
40,088. These figures include existing bounded Value/frame caches, whose counts
and admission rules are unchanged.

[Before assembly](2026-10-14-zig-unit-metadata-profiles/before.asm) shows
`value.scalar` allocating/poisoning 368 bytes and copying its 304-byte payload
through `memcpy`. [After assembly](2026-10-14-zig-unit-metadata-profiles/after.asm)
allocates/poisons 256 bytes and copies the 192-byte payload with inline vector
loads/stores. The immutable result still owns its copy; the amount copied falls
37%. Unit receivers and conversion sources now borrow storage. The native
`Unit.combine` symbol disappears after inlining; that alone is not proof that
combination work is free.

## Separate CPU captures

The raw compressed reports are in
[the profile directory](2026-10-14-zig-unit-metadata-profiles/), and their hashes
and sample counts are in the paired JSON. Percentages of Pump samples:

| Capture/category | Before | After |
| --- | ---: | ---: |
| `numbers/quantity`: target parsing | 2.0% | 0.0% |
| `numbers/quantity`: compatibility/dimensions | 0.5% | 0.0% |
| `numbers/quantity`: combination | 4.1% | 0.0% |
| `numbers/quantity`: dynamic conversion | 23.7% | 8.6% |
| `numbers/quantity`: ordered plan | 0.0% | 0.5% |
| `numbers/quantity`: memcpy | 0.3% | 0.0% |
| `numbers/quantity`: Value construction | 3.4% | 4.8% |
| `probe/conversion`: target parsing | 5.4% | 0.0% |
| `probe/conversion`: compatibility/dimensions | 1.4% | 0.0% |
| `probe/conversion`: combination | 2.6% | 0.0% |
| `probe/conversion`: dynamic conversion | 16.5% | 5.0% |
| `probe/conversion`: ordered plan | 0.0% | 1.4% |
| `probe/conversion`: memcpy | 0.3% | 0.0% |
| `probe/conversion`: Value construction | 5.6% | 4.7% |
| `probe/compound-conversion`: target parsing | 13.5% | 0.0% |
| `probe/compound-conversion`: compatibility/dimensions | 1.0% | 0.0% |
| `probe/compound-conversion`: combination | 2.9% | 0.0% |
| `probe/compound-conversion`: dynamic conversion | 16.0% | 8.2% |
| `probe/compound-conversion`: ordered plan | 0.0% | 1.1% |
| `probe/compound-conversion`: memcpy | 0.2% | 0.0% |
| `probe/compound-conversion`: Value construction | 5.0% | 6.8% |

Static target parsing disappears from these Pump profiles. Compatibility,
combination and payload copying are now partly/fully inlined: their zero named
samples must not be read as zero work. Dimensions are attributed through the
compatibility symbol, so the signature construction itself is not separately
resolved by the sampler. Assembly and the isolated comparison/conversion probes
provide the complementary evidence. Dynamic conversion and ordered-plan samples
are shown separately; the remaining Decimal operations retain their exact order.
Inclusive categories overlap and cannot be added.

## Fresh four-runner comparison and remaining gaps

The [numeric comparison](2026-10-14-zig-unit-metadata-four-way.md) and
[raw four-runner data](2026-10-14-zig-unit-metadata-four-way.json) use only native
Zig, the TS Core, AppleScript and GopherLua. Peer repetitions are three; TS uses
automatic sampling. Every output and TS/Zig Fuel parity check passes. Peers use
idiomatic ports and their native numeric types.

| Workload | Zig ms | AppleScript ms | Zig / AppleScript |
| --- | ---: | ---: | ---: |
| `numbers/add` | 0.540 | 0.223 | 2.42× |
| `numbers/multiply` | 0.318 | 0.170 | 1.87× |
| `numbers/divide` | 0.355 | 0.187 | 1.90× |
| `numbers/quantity` | 0.306 | 0.116 | 2.65× |

Quantity remains 2.65× slower than AppleScript in this fresh capture
(the issue's earlier evidence reported 3.36×). Its TS median is 3.896 ms and
GopherLua 0.0113 ms. Exact Decimal operations, charging and immutable Value
construction remain material costs; metadata optimization does not remove the
numeric-model differences between the Cores and peers.

## Implementation and limits

Static verified Unit targets retain their spelling, parsed Unit, dimension
signature and ordered factor plan in code-owned, counted storage. Metadata is
attached only to a Unit conversion operand, keeping ordinary instructions and
operand arrays at their previous sizes. Invalid target parsing still falls
through to runtime conversion, and failed value conversions are never promoted
into Load errors. Every factor operation remains separate, in Kind/phase order;
volume's extra factor alternates with its Unit factor within each repetition.
Exponent counts never expand a plan beyond twice the catalogue's Kind count.

Unit slots use catalogue-sized indices rather than `usize`; a derived active
Kind mask narrows dimension, combination and conversion traversals. Unit methods
borrow their payloads. Conversion borrows a Quantity's source Unit and the
static target, copying only the immutable result's payload. Cancellation of a
Kind updates the mask, and calendar validation uses the same restrictions.

The dynamic combination/dimension cache investigation stops at this structural
reuse: hashing/copying whole Unit pairs and retaining full descriptors would add
work and bounded physical capacity to operations now reduced to active slots.
There is no mutable runtime Unit cache. Code lifetime owns the metadata; Reload,
extension compilation and Restore use the existing compiler/storage path.
Canonical code, source positions, disassembly, Value Encoding and snapshots
exclude derived metadata.

## Validation

- All 233 native Zig tests and C Host tests pass. Differential conversion tests
  compare sparse traversal and plans against the original full-slot algorithm
  for every catalogue Unit, compound and ratio Units, signed values and zero,
  positive/lowest Decimal exponents, rounding/overflow boundaries and unbounded
  comparison intermediates. Catalogue-pair products/quotients preserve calendar
  refusals, and i32 exponent extremes preserve bounded plan capacity.
- Refusal tests exhaust conversion scratch and descriptor-copy allocations,
  check physical admission and free all partially completed work. The existing
  Library refusal audit includes container Constants and static Unit target
  lowering/copying, and disables in-place resizing to make allocation indices
  deterministic across the smaller Value layout; it still refuses every
  allocation in the fallback path.
- All 429 Corpus cases pass, including ordinary/restored Trace replay,
  disassembly, reload and save/restore. All 429 also pass with deferred crossings.
  No expected record is changed.
- The wasm32 Unit/Decimal root passes all 16 tests in Wasmtime, including the
  differential and refusal tests. WASI platform containment, the 100,000-Handler
  load-cap check and Message Layer protocol conformance pass.
- Repository Spec/docs/generated/API, Unicode, Zig format, lint and TS format
  checks pass.

## Reproduce

Build before editing, preserve its Host, then build the candidate:

```sh
cd impl/zig
zig build
cd ../..
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c impl/zig/zig-out/lib/libtalk.a -o /path/to/host
python3 bench/zig/unit-paths.py /path/to/before /path/to/after \
  --before-revision f51ad856e37d802b8865bb2870c3adebc293e7d1 \
  --pairs 3 --count 5 --profiles /path/to/profiles --out /path/to/results.json
bun run bench --only zig,ts,applescript,gopher-lua --filter numbers --count 3 --no-save
```

CPU captures use macOS `sample` for two seconds at 1 ms, counting only Pump
stacks. Categories are overlapping inclusive samples and must not be added.
An absent symbol after inlining does not mean its work is absent. Physical
allocation probes count Group allocator requests; they are neither logical
allocation nor resident memory.
