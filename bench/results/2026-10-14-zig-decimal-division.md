# Zig Decimal division and Unit conversion measurements 2026 10 14

Evidence for [#923](https://github.com/odogono/odgn-talk/issues/923), comparing
baseline `f385603fd2e3bb34856c578cf3d0c13254fcc809` (current `main`, including
the #922 focused runner) with this issue's optimization: exact terminating
division and integer `div`/`mod` paths in the Zig Decimal operators, and
compile-time parsed Unit factors with factor-one steps skipped. The
[raw measurements](2026-10-14-zig-decimal-division.json) retain three
before/after pairs across all 30 supported workloads (34 rows with the Fuel
Slice sweep), every timing sample, separate allocation probes, source and
binary hashes, and toolchain settings.

On Apple M5, macOS 27.0.1, arm64, Zig 0.17.0 in `safe` mode and Apple clang
21.0.0 at `-O2`, division improves from 0.960 to 0.503 ms (1.91×), Quantity
conversion from 1.264 to 0.714 ms (1.77×), and `text/index` (whose loop does
`i mod 16`) from 1.553 to 1.067 ms (1.46×). Every before/after measurement
preserves output, Fuel and logical allocation under language 1.0-rc.3 and
Cost Model 0; the allocation probes assert this per measurement, and no
blessed Corpus expectation changed.

## Method and baselines

The baseline Host was built and measured before any editing. Its five-sample
intake medians were 0.663 ms for addition, 0.438 ms for multiplication,
0.960 ms for division, 1.278 ms for Quantity conversion and 1.534 ms for
`text/index`, re-establishing the issue's figures locally rather than
assuming them.

The table reports the median of three per-process medians. Each process uses
five samples, each averaging complete Runs over at least 50 ms, after an
untimed output/accounting validation. For each workload, a baseline process
immediately precedes the optimized process, followed by separate untimed
allocation probes under a counting Host allocator. Load and compilation are
outside the Run timer. Other work was active on the machine, so these are
advisory paired measurements, not isolated-machine timing claims.

## Targeted workloads and allocation probes

Run medians in milliseconds; probe figures are cumulative Group allocation
requests during one Run under the counting allocator (frees do not subtract).

| Workload | Before ms | After ms | Speedup | Host allocs | Host bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| `numbers/divide` | 0.960 | 0.503 | 1.91× | 23062 → 28 | 651104 → 12788 |
| `numbers/quantity` | 1.264 | 0.714 | 1.77× | 23032 → 30 | 654962 → 13532 |
| `text/index` | 1.553 | 1.067 | 1.46× | 23526 → 1030 | 685838 → 16577 |

The remaining `text/index` requests are its text work, not Decimal scratch:
the `mod` in its loop no longer allocates. Addition and multiplication are
unchanged (0.677 → 0.677 ms and 0.438 → 0.437 ms, allocations identical).
Allocation counts and bytes are identical before/after on all 31 remaining
rows, and their Run medians stay within 0.98–1.10× except
`core/fib@slice=10` (0.86×) and `messaging/suspend` (0.94×). Neither is on a
changed operator path — unsliced `core/fib` and `numbers/add`, which share
the slice workload's arithmetic, are at 1.00× — and the slice row's three
pairs span 4.879–5.779 ms after against 4.782–4.842 ms before, so both read
as layout or machine noise; the raw JSON retains every sample either way.

## Residual AppleScript gaps

A focused four-runner run in the same session (`--only
zig,ts,applescript,gopher-lua --count 3`, medians of three repeats, Fuel
parity on both Cores) gives, against the issue's baseline ratios:

| Workload | Zig after | AppleScript | Gap after | Gap at issue |
| --- | ---: | ---: | ---: | ---: |
| `numbers/divide` | 0.518 ms | 0.191 ms | 2.71× | 5.01× |
| `numbers/quantity` | 0.713 ms | 0.116 ms | 6.15× | 10.66× |
| `text/index` | 1.094 ms | 0.886 ms | 1.23× | — |

Decimal scratch allocation is no longer the Quantity cost: its probe is down
to 30 requests per Run, the same order as plain addition. The residual
Quantity gap is the remaining first-class Unit arithmetic and machine loop
work, which the AppleScript port does not perform (it applies plain numeric
factors). These ratios are workload targets, not equivalent-instruction
costs, per the issue's constraints.
