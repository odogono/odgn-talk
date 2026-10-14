# Zig call storage measurements — 2026-10-14

Evidence for [#926](https://github.com/odogono/odgn-talk/issues/926). The bounded
frame-buffer cache reduces parent allocation requests in `core/calls` from
4,028 to 29 and in Fibonacci from 4,002 to 85. Default-allocator medians shift
by about 1–2% on the four target workloads; this is a reduction in demonstrated
allocation churn, with a small timing effect. A measured boxed-Quantity
prototype reduces Value nodes from 368 to 128 bytes, but adds 1,000 parent
allocations per Quantity Run. Its representation change is rejected for this
patch; the experiment is retained for reproduction.

## Measurement boundary

The [paired raw data](2026-10-14-zig-call-storage.json) isolate this patch
against `8f98a485` (after #923), across all 30 supported native workloads,
including the Fibonacci Fuel Slice sweep: three pairs, five samples per
process, alternating before/after order between pairs. Each sample averages
complete checked Runs over at least 50 ms. Load has its own timing samples.
This isolates call storage from the subsequently merged #924 List work.
Source and binary hashes, manifest, machine and toolchain versions are in the
raw data. `checkoutRevision` names the parent of the measured working tree;
`afterSourceSha256` names its changed sources.

Apple M5, arm64, macOS 27.0.1, Zig 0.17.0 `safe`, Apple clang 21 at `-O2`,
language 1.0-rc.3, Cost Model 0. Timing uses the default allocator. Allocation
probes run separately, untimed, through the C counting allocator. Every
before/after/probe pair checks output, exact Fuel and logical allocation.
Initial exploratory timings made during builds were discarded. Ordinary
machine activity still affects short timings; these percentages are observed
medians, not guaranteed speedups.

## Call storage and ownership

A Group retains at most 32 released frame buffers of at most 1,024 bytes each:
**at most 32 KiB**, independent of recursion depth, Scripts and repeated Runs.
On this native target its intrusive header is 16 bytes, so 16-byte Fibonacci
locals, 24-byte call locals, 32-byte Lambda locals and 144-byte operand buffers
are eligible. Smaller, larger, insufficiently aligned and excess buffers
return to the parent. A subsequent allocation can consume a buffer only with
exactly the same byte size and alignment. The frame-record ArrayList already
reuses its capacity during a Run.

Every local Value and operand Slot is released before its buffer is retained;
the cache owns bytes, with no live Value, capture, iterator, reader, replacement
or code reference. New frames initialise every local and begin with an empty
operand stack. Unbound locals share one immutable Nothing per call, with one
owned reference per slot. Suspended and held frames keep their existing
ownership. Restored frames use the same retirement path when popped.

Retained buffers remain in physical `used` and `peak`. Allocation, resize and
remap cap pressure flush both frame and Value caches before admission can
refuse. Group release gives every cached buffer back; plain machine allocators
free frame buffers directly. Logical sizes and charges stay unchanged. Current
support and the ownership contract are in the [Zig guide](../../impl/zig/README.md).

## Paired native timings and memory

Figures are medians of three per-process medians, in milliseconds. Physical
peak includes Load; held bytes are `talk_group_memory.used` after one checked
Run, including all Group storage and cached capacity. Held-byte deltas are
not isolated frame-cache sizes. Parent requests exclude Load. None of these
memory figures is RSS.

| Workload        | Before ms | Reuse ms | Change | Parent requests | Physical peak bytes |      Held bytes |
| --------------- | --------: | -------: | -----: | --------------: | ------------------: | --------------: |
| core/calls      |     0.908 |    0.896 |  -1.4% |      4,028 → 29 |     31,676 → 31,676 | 10,966 → 11,310 |
| core/fib        |     0.940 |    0.917 |  -2.4% |      4,002 → 85 |     31,370 → 31,370 | 19,336 → 21,896 |
| core/lambdas    |     1.230 |    1.205 |  -2.0% |      4,042 → 43 |     26,592 → 26,592 | 12,549 → 13,157 |
| macro/game-tick |     1.732 |    1.695 |  -2.1% | 14,042 → 12,043 |     66,528 → 66,528 | 16,504 → 17,096 |

The geomean after/before ratio across 30 workloads is 0.997. Most changes are
within a few percent. The broad sweep's `messaging/suspend` median rose 12.9%,
so it was checked again in [seven independent pairs](2026-10-14-zig-call-storage-suspension.json):
paired changes range from −7.8% to +16.9%, with median paired change +0.7%.
That variation does not establish a consistent suspension regression or a
useful speedup. The tiny `host/pump` workload shifts −7.1% (about 0.1 μs),
and `text/build` shifts −6.2%; do not attribute those small-workload shifts to
call storage without further evidence.

## Where the work remains

Separate two-second, 1 ms [CPU samples](2026-10-14-zig-call-storage-profiles/)
contain about 1,500 Pump samples per capture. Long Run phases allow for the
macOS sampler's attachment delay; sampling ends before Load and the process is
then terminated. These captures supply no timing samples. Inclusive categories
overlap, and compiler inlining limits attribution.

| Workload     | Allocator samples before / Pump | Allocator samples after / Pump | Frame-pop samples before → after | Value construction before → after |
| ------------ | ------------------------------: | -----------------------------: | -------------------------------: | --------------------------------: |
| core/calls   |                        167/1496 |                       161/1501 |                          51 → 20 |                           61 → 71 |
| core/fib     |                        194/1495 |                       161/1498 |                          38 → 27 |                           62 → 70 |
| core/lambdas |                        184/1509 |                       156/1506 |                          38 → 32 |                           78 → 64 |

The exact allocation probe distinguishes local/operand buffers by size from
368-byte scalar nodes: `core/calls` had 2,000 local requests at 24 bytes and
2,003 operand requests at 144 bytes; after reuse its leading sizes contain
three 144-byte requests and no 24-byte requests. Fibonacci's 1,974 16-byte
requests and 1,976 144-byte requests are reduced to a bounded warm-up. Lambdas
similarly eliminate the per-call 32-byte/144-byte churn. `game-tick` still
allocates Text keys and Map buffers: its requests fall by 1,999, not to zero.

Scalar constructors still run through the existing 128-node Value cache.
The [baseline generated constructor](2026-10-14-zig-call-storage-profiles/scalar-before.asm)
poisons 368 bytes with checked-build undefined storage and copies the 304-byte
Data union for each construction. Reference retain/release still updates the
node's counter; after reuse, captures and other aliases continue to own their
references. The call samples retain Value construction/release traffic, while
Decimal work accounts for only 39/1,496 before and 40/1,501 after call samples.
The arithmetic scratch removed by prior Decimal work is separate from the
remaining local/operand buffers; request-size histograms cannot attribute
arbitrary scratch by themselves. Remaining allocator samples also include
cache, Arena and other allocation bookkeeping, so frame reuse cannot claim
that it removes the full allocator share.

## Compact Value experiment

The [reproducible prototype patch](../zig/experiments/boxed-quantity.patch)
changes only internal Value storage: Quantity payloads have a separately owned
288-byte box, released with their Value; all nodes become 128 bytes. Constructors
retain the original by-value payload interface. The
[generated prototype constructor](2026-10-14-zig-call-storage-profiles/scalar-compact.asm)
poisons 128 node bytes and adds tag dispatch; Quantity construction also
allocates, initialises and copies its 288-byte payload. This is a measured boxed
payload experiment, with reference counting preserved.

[Three paired sets](2026-10-14-zig-compact-values.json), five samples each,
compare the retained call-storage patch with that patch plus the prototype:

| Workload         | Reuse ms | Compact ms | Change | Parent requests |
| ---------------- | -------: | ---------: | -----: | --------------: |
| core/loop        |    1.581 |      1.511 |  -4.4% |         24 → 24 |
| core/calls       |    0.974 |      0.953 |  -2.1% |         29 → 29 |
| core/fib         |    1.079 |      1.048 |  -2.8% |         85 → 85 |
| core/lambdas     |    1.313 |      1.261 |  -4.0% |         43 → 43 |
| numbers/add      |    0.731 |      0.716 |  -2.1% |         26 → 26 |
| numbers/multiply |    0.481 |      0.458 |  -4.8% |         27 → 27 |
| numbers/divide   |    0.509 |      0.484 |  -5.1% |         27 → 27 |
| numbers/quantity |    0.517 |      0.507 |  -1.9% |      29 → 1,029 |
| macro/game-tick  |    1.825 |      1.746 |  -4.3% | 12,043 → 12,041 |

All prototype checks preserve output, Fuel and logical allocation. Held memory
falls: calls 11,310 → 9,150 bytes, Fibonacci 21,896 → 13,496 bytes, Quantities
12,462 → 9,918 bytes. The new Quantity payload requests are 288 bytes × 1,000;
parent requests rise from 29 to 1,029. Default timing gains are modest, and the
Fuel Slice sweep varies (slice 100 is +9.9% in these pairs). The small-node
hypothesis has some support for construction traffic, but this particular
rewrite is rejected: it reintroduces per-Quantity parent churn for a small
measured gain, expands ownership/refusal cases, and has not passed the complete
representation/lifecycle conformance gate. It is an experiment artifact, not
runtime code. A future representation change needs a measured Quantity storage
strategy as well as scalar gains.

## Fresh four-runner comparison

The [fresh comparison data](2026-10-14-zig-call-storage-comparison.json)
contains three repeats of the existing runner with only native Zig, TS,
AppleScript and GopherLua, for `core` and `macro/game-tick`. The TS and Zig
Fuel records agree on every comparison. Each runner uses its own existing
sampling policy; peer figures are the median of three per-process medians.
These are complete workload ports with native peer numeric types, not
instruction-equivalent kernels. The original #922 gaps belong to its named
revision; the ratios below use the fresh contemporaneous run.

| Workload        | Zig reuse ms | TS ms | AppleScript ms | GopherLua ms | Zig / AppleScript |
| --------------- | -----------: | ----: | -------------: | -----------: | ----------------: |
| core/calls      |        0.877 | 2.754 |          0.597 |        0.071 |             1.47× |
| core/fib        |        0.915 | 2.347 |          0.471 |        0.072 |             1.94× |
| core/lambdas    |        1.179 | 3.903 |          0.645 |        0.086 |             1.83× |
| macro/game-tick |        1.685 | 3.914 |          1.378 |        0.126 |             1.22× |

Call storage leaves substantial Fibonacci/Lambda/game-tick gaps against
AppleScript. The primary improvement is parent allocation churn; it does not
resolve dispatch, Value construction, Decimal or collection costs.

## Verification and reproduction

Reconciled with #924 at `774923de`, the retained implementation passes 225 native Zig tests plus the C Host,
all 429 Corpus cases (every Trace in ordinary and between-Pump restored replay),
all 429 again with deferred crossings, the TS/Zig witness/mutation suite,
generated tables, `talk.h` API comparison, format/lint and Spec checks.
New tests exercise bounded retention, cap eviction, 80-deep recursion with
retained captures across repeated Runs, and every parent allocation refusal
through recursive calls. Existing cases cover foreign/nested calls, suspended
frames, recovery/error cleanup, cancellation, rollback and restored ownership.
Expected records and the save format are unchanged.

WASI platform checks pass with the 1 MiB stack, containment, metering, supported
limits/call depth, deep source and large-load checks. Raw payload is 3,022,732
bytes; Brotli-11 is 689,706 bytes. This is conformance evidence, not a WASM
performance comparison.

Build two native `safe` libraries from `8f98a485`, adding only this PR's
call-storage runtime patch to the second checkout. Compile each with the same
current `bench/zig/host.c`:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c /path/to/libtalk.a -o /path/to/host
python3 bench/zig/call-storage.py /path/to/before /path/to/reuse \
  --before-revision 8f98a485 --all --pairs 3 --count 5 \
  --out /path/to/paired.json --profiles /path/to/profiles
```

For the compact experiment, apply `bench/zig/experiments/boxed-quantity.patch`
to the reuse checkout, rebuild, then pass reuse/compact hosts to the same
script without `--all`. Set `--before-source-root` to the reuse checkout and
`--after-source-root` to the prototype checkout so their source hashes are
recorded. Use `--profiles-only` to replace separate captures in an existing
JSON and `--filter messaging/suspend --pairs 7` for the follow-up. The assembly
artifacts use `xcrun llvm-objdump --disassemble-symbols=_value.scalar <host>`.

The fresh comparison repeats these existing commands three times (retain
each JSON before the next filtered run writes the suite's dated filename):

```sh
bun run bench --only zig,ts,applescript,gopher-lua --filter core --count 3
bun run bench --only zig,ts,applescript,gopher-lua --filter macro/game-tick --count 3
```

No Elixir, other Peer Language, or WASM timing run is included.
