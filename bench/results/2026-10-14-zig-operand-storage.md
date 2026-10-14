# Zig protected-operand storage — 2026-10-14

For [#925](https://github.com/odogono/odgn-talk/issues/925), reuse the eight-slot operand buffer within each `execute` call and clear only its live-slot metadata after releasing retained operands. Native safe-mode disassembly shows that both per-instruction 416-byte copies disappear. One initialization remains at execution entry, including when a preempted Run resumes.

## Base and method

The baseline is `774923de`, containing #922, #923 and #924. Main advanced during the initial experiment; the final measurements below were repeated after integrating #924. The after binary contains this PR’s operand-storage change on that base. [Raw paired measurements](2026-10-14-zig-operand-storage.json) record binary hashes and before/after source hashes; the measured change was uncommitted at measurement time.

Apple M5, macOS 27.0.1, Zig 0.17.0 in default `safe` mode, the unchanged native C Host at `-O2`, Language 1.0-rc.3 and Cost Model 0. Each of three alternating-order pairs has five samples per process. Each sample averages complete Runs over at least 50 ms after an untimed output/accounting validation. Load and compilation are outside the Run timer. Counting-allocator probes and CPU profiles run separately from timings.

No builds, tests or other benchmarks from this thread ran during timings or profiling. Other repository work was active on the machine. These are advisory paired results, with visible process-to-process variation; they are not isolated-machine estimates or confidence intervals. Pair ratios are included because ratios of aggregate medians can differ when the machine’s load changes.

## What the copies initialize

The [native disassembly excerpts](2026-10-14-zig-operand-disassembly.txt) identify the calls through the Mach-O indirect-symbol table. Generic `llvm-objdump` mode mislabels these imported stubs; their resolved symbol is `memcpy`.

At baseline, `held: Operands = .{}` initializes 416 bytes before every instruction. `Operands.release` assigns the same whole-struct constant after releasing slots and overflow storage; the ordinary path is inlined on the loop backedge. Both execute copy sites use the same stack destination. The source constant contains 384 zero bytes for eight 48-byte Slots, the empty `more` slice (pointer `0x10`, length zero), `len = 0` and eight zero padding bytes. The unused inline bytes describe no live owners.

After the change, initialization occurs once before the execution loop. Release writes the empty slice and zero length, without touching the inline buffer. `take` writes every retained slot before publishing `len`; reads and releases use only that live prefix, or the separately allocated overflow slice. Overflow allocation, safe free poisoning, slot reference retention and the existing per-instruction defer remain in place. The reusable buffer is local to execution, so it adds no Group, Run, frame or snapshot fields.

## CPU samples

Each binary is sampled separately for two seconds at 1 ms intervals. The profiler keeps the Host in its Run phase for at least 15 seconds to accommodate attachment and symbolication delays, terminates it after collecting the report, and requires at least 500 Pump samples. Earlier short attempts sampled startup or Load and were discarded. The final [26 compressed reports](2026-10-14-zig-operand-profiles/) have their hashes and Pump sample counts in the JSON.

Only stacks beneath `talk_pump` contribute. The copy category sums disjoint direct `memcpy`/platform-memory-move children of `Group.execute`; their before call offsets correspond to the two disassembled operand copies. The JSON’s other categories aggregate exclusive leaves through named ancestors, avoiding recursive double counting. Inclusive categories overlap and must not be added.

| Unsliced workload | Pump samples before / after | Operand-copy samples before / after | Charging before / after | Scratch reset before / after |
| --- | ---: | ---: | ---: | ---: |
| `core/loop` | 1498 / 1537 | 226 / 0 | 14.8% / 20.0% | 6.3% / 5.0% |
| `core/calls` | 1469 / 1523 | 216 / 0 | 14.0% / 18.8% | 4.4% / 5.5% |
| `core/fib` | 1492 / 1534 | 204 / 0 | 10.8% / 14.1% | 5.6% / 3.7% |
| `probe/straightline` | 1418 / 1492 | 274 / 2 | 15.0% / 20.8% | 8.7% / 7.2% |
| `probe/protected-loop` | 1465 / 1538 | 196 / 0 | 14.1% / 17.8% | 5.9% / 5.0% |

The two after-copy samples in straight-line execution correspond to the remaining entry initialization at `execute +88`. Charging and scratch reset still run at every existing boundary. Their sampled shares can grow when copying disappears; this is not evidence of extra accounting work. Common-charge specialization and scratch-reset changes remain separate measurement opportunities. `Operands.take` is inlined, so zero named retention samples do not imply zero retention work. The protected-loop probe executes inside a `try/finally` scope with operand retention active.

## Paired timings

Medians are the median of three per-process medians, in milliseconds. The table shows the Run phase, including for the lifecycle workloads; raw JSON also retains Load timings. Pair speedups compare adjacent before/after processes. The straight-line probe performs 256 local-to-local moves. The protected loop uses `repeat for each` inside `try/finally`, so its instruction count differs from the ordinary `repeat while` loop. All five requested targets include unsliced and sliced execution; Fibonacci sweeps slice 10, 100, 1000 and 10000.

| Workload | Before ms | After ms | Speedup | Pair speedups |
| --- | ---: | ---: | ---: | --- |
| `core/loop` | 1.3397 | 1.0499 | 1.28× | 1.28×, 1.26×, 1.23× |
| `core/loop@slice=100` | 1.8148 | 1.4907 | 1.22× | 1.24×, 1.20×, 1.93× |
| `core/fib` | 0.9554 | 0.7637 | 1.25× | 1.25×, 1.25×, 1.28× |
| `core/fib@slice=10` | 5.0999 | 4.8607 | 1.05× | 1.04×, 1.04×, 1.05× |
| `core/fib@slice=100` | 1.3579 | 1.1906 | 1.14× | 1.15×, 1.13×, 1.20× |
| `core/fib@slice=1000` | 0.9890 | 0.8162 | 1.21× | 1.21×, 1.21×, 1.20× |
| `core/fib@slice=10000` | 0.9661 | 0.7811 | 1.24× | 1.25×, 1.24×, 1.24× |
| `core/calls` | 0.9070 | 0.7213 | 1.26× | 1.26×, 1.25×, 1.27× |
| `core/calls@slice=100` | 1.3434 | 1.1562 | 1.16× | 1.08×, 1.18×, 1.18× |
| `core/lambdas` | 1.2196 | 0.9832 | 1.24× | 1.24×, 1.24×, 1.26× |
| `numbers/add` | 0.6747 | 0.5164 | 1.31× | 1.31×, 1.31×, 1.33× |
| `numbers/multiply` | 0.4426 | 0.3389 | 1.31× | 1.29×, 1.32×, 1.27× |
| `numbers/divide` | 0.4638 | 0.3712 | 1.25× | 1.25×, 1.24×, 1.25× |
| `numbers/quantity` | 0.4726 | 0.4074 | 1.16× | 1.16×, 1.14×, 1.17× |
| `text/build` | 0.4734 | 0.4365 | 1.08× | 1.10×, 1.07×, 1.05× |
| `text/iterate` | 0.7411 | 0.5963 | 1.24× | 1.24×, 1.22×, 1.32× |
| `text/index` | 1.0341 | 0.9160 | 1.13× | 1.13×, 1.13×, 1.15× |
| `text/patterns` | 0.6426 | 0.6035 | 1.06× | 1.06×, 1.06×, 1.07× |
| `text/graphemes` | 1.3563 | 1.1515 | 1.18× | 1.18×, 1.19×, 1.18× |
| `collections/list-build` | 0.3113 | 0.2423 | 1.29× | 1.29×, 1.29×, 1.30× |
| `collections/list-append` | 1.3898 | 1.0275 | 1.35× | 1.35×, 1.34×, 1.35× |
| `collections/map-build` | 0.9769 | 0.9092 | 1.07× | 1.07×, 1.04×, 1.08× |
| `collections/list-update` | 0.7789 | 0.5962 | 1.31× | 1.31×, 1.33×, 1.33× |
| `collections/map-update` | 0.2846 | 0.2357 | 1.21× | 1.21×, 1.20×, 1.21× |
| `collections/iterate` | 2.1475 | 1.6140 | 1.33× | 1.33×, 1.33×, 1.34× |
| `host/pump` | 0.0017 | 0.0017 | 0.96× | 0.99×, 0.95×, 0.94× |
| `macro/transform` | 0.4100 | 0.3145 | 1.30× | 1.26×, 1.30×, 1.27× |
| `macro/report` | 1.2605 | 1.2183 | 1.03× | 1.04×, 1.03×, 1.03× |
| `macro/game-tick` | 1.7622 | 1.4597 | 1.21× | 1.20×, 1.21×, 1.20× |
| `messaging/suspend` | 3.2349 | 2.9689 | 1.09× | 1.06×, 1.09×, 1.03× |
| `lifecycle/load-small` | 0.0018 | 0.0018 | 1.02× | 0.93×, 1.03×, 1.10× |
| `lifecycle/load-large` | 0.1790 | 0.1624 | 1.10× | 1.12×, 1.10×, 1.12× |
| `probe/straightline` | 0.0179 | 0.0140 | 1.27× | 1.33×, 1.27×, 1.31× |
| `probe/straightline@slice=100` | 0.0224 | 0.0181 | 1.24× | 1.27×, 1.23×, 1.20× |
| `probe/protected-loop` | 0.6385 | 0.5044 | 1.27× | 1.23×, 1.38×, 1.22× |
| `probe/protected-loop@slice=100` | 0.8428 | 0.7196 | 1.17× | 1.20×, 1.17×, 1.20× |

Every unsliced requested target improves in all three pairs, with aggregate Run time reductions of about 20–22%. Sliced variants retain the same output and accounting. `host/pump` (one empty Handler Delivery/Pump) initially measures 3.9% slower; a separate [five-pair recheck](2026-10-14-zig-operand-regression-check.json), with ten samples per process, measures 1.709 → 1.734 µs (1.4% slower), with mixed pair speedups of 0.97×, 1.05×, 1.02×, 1.23× and 0.98×. This does not establish a repeatable material regression. The small difference remains within the observed process variation. The nine manifest workloads outside the benchmark Host’s support remain outside these timings, as the [suite guide](../README.md#native-zig-comparison) describes.

## Four-runner comparison

The [fresh core comparison](2026-10-14-zig-operand-peers.md) selects only native Zig, the NorthTalk TS Core, AppleScript and GopherLua, with three repeats for Zig and peers and mitata’s automatic TS samples. It validates output and overlapping Core Fuel. It does not run WASM peers, Elixir or other Peer Languages. Peer ports use idiomatic control flow and native numeric types, so their ratios are workload targets rather than equivalent-instruction costs. In particular AppleScript’s loop is counted, whereas NorthTalk’s loop tests a condition and performs two additions.

In that fresh comparison, Zig/AppleScript Run ratios are 6.24× for the loop (1.124 / 0.180 ms), 1.18× for calls (0.706 / 0.599 ms), 1.60× for Fibonacci (0.755 / 0.472 ms) and 1.49× for Lambdas (0.960 / 0.646 ms). The loop gap remains substantial; the operand change narrows it without making the two ports instruction-equivalent. Zig is also faster than the TS Core in these selected workloads. GopherLua remains faster than both NorthTalk Cores.

## Accounting, boundaries and retained memory

All 108 comparisons across 36 workload/slice variants reproduce exact output, Fuel and logical allocation on both binaries and both allocator probes. All probes also reproduce every recorded Group allocation field: request/frees counts, requested bytes, live peak delta, top request sizes and Group peak. The buffer adds no retained Group capacity and makes no allocator requests. For example, loop remains 48,016 Fuel / 64,000 logical bytes, calls 46,018 / 32,072, and Fibonacci at every slice 46,365 / 47,328.

The holder’s initialization moves; instruction dispatch, charge formulas and payment sites, instruction positions, preemption, cancellation/Stop, failed-continuation accounting, pending cleanup, Limit Faults and restored continuations retain their existing code and boundaries. Each instruction retains protected operands before execution and releases them after instruction completion or unwind, through the same defer. Allocation refusal occurs before any overflow slots are retained.

Counting-allocator probes cover one Delivery/Pump Run, excluding Load and process-owned Host Values/returned bytes; frees do not subtract cumulative requests. Group peak includes Load. The counting allocator uses `posix_memalign`, so it diagnoses physical requests separately from default-allocator timings.

## Validation

- `zig build install test corpus --summary all`: all 222 Zig tests and native C Host tests pass, including storage reuse across inline/overflow/empty retention, allocation refusal, unprotected instructions and `throw`. Existing tests cover recovery, scheduling, accounting, cancellation/Stop and Limit Faults.
- `zig build corpus` and `zig build corpus -- --defer-crossings`: all 429 cases pass through `talk.h`, including ordinary and between-Pump Save/Restore Trace replay. Source positions, preemption, failed continuations and retained cleanup state match existing records.
- The same Corpus Host compiled with `-target wasm32-wasi -Osafe` passes all 429 cases in Wasmtime, including restored Trace replay.
- `zig build -Dtarget=wasm32-wasi`, `uv run tools/wasi/zig.py` and `uv run tools/wasi/check.py`: shipping safe reactor and Message Layer checks pass, including physical-cap containment and healthy Groups after refusal.
- `bun test tooling/fuzz/tests/zig-runner.test.ts`: both witness/mutation tests pass (33 assertions), comparing complete TS Traces.
- Unicode preparation, generated-table and C API catalogue checks, `zig fmt --check impl/zig`, `bun run check`, lint and formatting pass. The Spec and blessed expectations have no changes.

All runtime checks were repeated on the integrated #924 base before the final measurements.

## Reproduction

Build each revision in `impl/zig` with `zig build`, retaining default safe mode, then preserve its C Host before building the other revision:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c impl/zig/zig-out/lib/libtalk.a -o /path/to/host
python3 bench/zig/instruction-bookkeeping.py /path/to/before /path/to/after \
  --before-revision 774923de --pairs 3 --count 5 \
  --profiles /path/to/profiles --out /path/to/results.json
python3 bench/zig/instruction-bookkeeping.py /path/to/before /path/to/after \
  --before-revision 774923de --filter host/pump --pairs 5 --count 10 \
  --out /path/to/regression-check.json
bun run bench --filter core --only zig,ts,applescript,gopher-lua --count 3 --no-save
```

The test-only WASI Corpus Host uses the unchanged Core sources, translated WASI C headers and an 8 MiB stack; its temporary Corpus source maps `../../corpus` to `corpus` and preopens the repository root. The [earlier bookkeeping report](2026-10-14-zig-instruction-bookkeeping.md#validation) contains the full build command. The shipping reactor keeps its normal 1 MiB stack.
