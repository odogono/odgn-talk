# Benchmark Suite

The standalone [Message Layer C Host](message-layer-c/) measures WASI embedding
through Wasmtime, including Pump and Capability exchanges, startup, memory and
fault isolation. Its measurements are separate from the Core/Peer suite below.

Measures how fast each Core runs the same Scripts, to find slow paths and to compare NorthTalk with its Peer Languages. Nothing here is normative. [ADR 0054](../docs/adr/0054-benchmarks-live-outside-the-cores-and-only-advise-the-cost-model.md) records why the suite lives outside the Cores and only advises the Cost Model.

```sh
bun run bench [--filter <text>] [--only <runner,...>] [--count <n>] [--smoke] [--no-save] [--html <path>] [--outlier-factor <k>]
```

- **`--filter`** keeps the Benchmarks whose names contain the text, such as `core` or `core/fib`.
- **`--only`** runs a comma-separated selection of Cores (`go`, `ts`, `zig`) and [Peer Language runners](#peer-languages). `peers` selects every Peer Language. With multiple Cores, a Benchmark whose Fuel differs between them fails the run. Only selected runners start; version collection also uses only their dependencies.
- **`--count`** is the Go `-count` and the number of Zig, CPython and AppleScript repeats, 10 by default. mitata picks the sample count on Bun.
- **`--smoke`** runs each Benchmark once at its smoke size and checks output and Fuel parity, without saving anything. Its timings mean nothing. CI runs it on Linux for every PR that touches a Core, the suite or the Cost Model data ([`bench.yml`](../.github/workflows/bench.yml)).
- **`--no-save`** prints the report without writing it to `results/`.
- **`--html`** also writes the run as [the benchmark page](#the-benchmark-page), even when Fuel differs.
- **`--outlier-factor`** sets the Cost Model outlier threshold, 3 by default.
- **Exit codes:** 0 when every Benchmark and every port produced its expected output and Fuel agreed, 1 otherwise.

The CPython runner needs [uv](https://docs.astral.sh/uv/), which downloads the pinned CPython on first use. AppleScript runs only on macOS, and is left out of runs elsewhere. A full wave 1 run takes about 20–30 minutes with the default ten Go samples. It prints a Markdown report and writes it, with the JSON it came from, to `results/<date>-<os>-<arch>-<cpu>.{md,json}`. Runs with `--only` append the expanded runner selection to the filename, so a selected comparison does not replace that day's full report. Each file records the commit, machine, and the selected runners' versions alongside the language and Cost Model versions.

To compare the native Zig and TS Cores with AppleScript and Lua, without the
WASM peers or other languages:

```sh
bun run bench --only zig,ts,applescript,gopher-lua --count 3
```

`ts` is the NorthTalk TS Core; `ts-native` is the peer's native TypeScript port.
`gopher-lua` is Lua 5.1 hosted in Go; `wasmoon` is the WASM Lua runner. The command
above uses Go only to host Lua. Add `--filter core` for a smaller workload set,
or `--smoke` to check outputs and Fuel before measuring. Elixir and the separate
WASI embedding benchmarks are outside this suite and are not started.

When the `ts` runner is selected, the report also gives each Core's [Payload](../GLOSSARY.md): the core-switch Example Host bundled for a browser, the whole `@northtalk/ts` entry, and the Zig Core's `@northtalk/ts/wasm` Host with `talk.wasm`, raw, gzip -9 and Brotli-11, measured as in [the browser figures](../docs/research/zig-browser-figures.md). The Zig Core's half needs the reactor built first, with `zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi` in `impl/zig`, and is left out without it.

## Comparing a branch with main

To measure a TS Core or tooling change, compare this tree with a base revision:

```sh
bun run bench:compare [<ref>] [--filter <text>] [--rounds 3] [--node]
```

- **`<ref>`** is the base, `origin/main` by default. It is fetched, checked out into `.cache/bench-compare/base` and installed there. Later runs reuse that worktree.
- **`--filter`** works as it does for `bun run bench`, such as `lifecycle/load` or `tooling`.
- **`--rounds`** sets the number of alternating rounds, 3 by default. Odd rounds run the base first and even rounds this tree, so a machine slowing down affects both sides equally.
- **`--node`** also runs both trees under Node, from bundles built into each tree's `bench/ts/dist/`.

It prints a Markdown table of the Load and Run medians on both sides, the change and each side's range across rounds. Runs vary by ±5–8% on a quiet machine, so a change below 8% is marked as noise. Benchmarks under 0.1 ms vary more than that, as does any run on a busy machine. Before you rely on a large change, check that the two sides' ranges do not overlap. Remove the base with `git worktree remove .cache/bench-compare/base`.

## Tooling Benchmarks

`tooling/lsp-reanalyse` runs only on the `ts` runner. It times one LSP edit-and-reanalyse cycle: a line of `first.talk` in [`scripts/tooling/lsp-project`](scripts/tooling/lsp-project/) changes, then the LSP workspace (`createWorkspace` in `tooling/stack/src/lsp/workspace.ts`) reanalyses it, as `didChange` does: it parses, checks, lints and lowers again only what the edit changed. The project is a Library of 40 functions and two Scripts that import it. Unlike `lifecycle/load-*`, it does no Group setup and runs no Script, so it has no Load, Fuel or parity check. It fails when any document has a syntax error or does not lower. `--filter tooling` selects it.

The `ts` runner measures it on Bun. For a Node figure, build and run its own entry:

```sh
bun build bench/ts/src/measure-tooling.ts --target node --outdir bench/ts/dist
node bench/ts/dist/measure-tooling.js [filter] [smoke]
```

## The benchmark page

[`docs/benchmarks.html`](../docs/benchmarks.html) shows one run as a single page with no external resources: the Payload, Fuel parity, Cost Model outliers, a bar chart per Benchmark comparing each runner's Run median with its min–max range, and a sortable table of every measurement. Open it from a clone; GitHub shows its source.

The [Benchmark page workflow](../.github/workflows/bench-page.yml), run by hand from the Actions tab with optional `count`, `filter` and `only`, runs the suite on `ubuntu-latest` and opens a `docs(repo)` PR with the page and the run's results. Its timings come from a shared runner and are advisory, never a gate. A run that fails, such as on a Fuel difference, uploads the page as an artifact instead.

The workflow approves and auto-merges its PR with the `BENCH_PAGE_TOKEN` secret, a fine-grained token with Contents and Pull requests write on this repository, and needs "Allow auto-merge" and "Allow GitHub Actions to create and approve pull requests" turned on. Without the secret, the PR waits to be merged by hand.

To render a saved run again:

```sh
bun run bench:html results/<run>.json [out.html]
```

The output defaults to `docs/benchmarks.html`.

## Native Zig comparison

The default run includes the native Zig Core through `talk.h`, built with the
pinned Zig 0.17.0 compiler in its default `safe` mode (bounds and overflow checks
kept). A C compiler builds the Host with `-O2`; both builds finish before timing.
`bun run bench --only zig` selects it alone. Zig runs all 21 Peer Language
workloads, the Fuel Slice sweep, graphemes, empty Handler Delivery/Pump, suspension and Load
workloads. The nine workloads requiring additional Host bindings are explicitly
skipped in the manifest: these are benchmark Host limitations, not missing Core
features.

Each Zig sample averages calls over at least 50 ms, with `--count` samples and
one untimed validation Run first. Every timed Run checks its output and accounting;
Fuel must agree with the TS Core and the Go embedding. Load uses a fresh Script name each time,
with Group destruction outside the Load timer. Run includes Delivery, pumping,
report collection and result display on an already loaded Script. Native memory
allocation is not measured by the default suite. Smoke timings are not
performance measurements.

For a focused Map construction size sweep, build the native Host as
`ts/src/measure-zig.ts` does, then run:

```sh
python3 bench/zig/map-scaling.py .cache/bench-zig/host --count 5
```

This checks output, Fuel and logical allocation at 100, 300, 1,000 and 3,000
entries under the Host's existing budgets. Timings use the default allocator;
separate untimed probes set `NORTHTALK_BENCH_ALLOCATIONS=1` to use a counting
Host allocator. `hostBytes` and `hostAllocs` count cumulative Group allocation
requests during one Run, excluding Load and process-owned Host values/returned
bytes; frees do not subtract. `hostFrees` counts free calls in the same span,
`hostLivePeakDelta` is the largest rise in live requested bytes above the
level at Run start, and `hostTopSizes` lists the exact request sizes with the
most requests, so a fixed-size node stands apart from variable-size scratch
and collection buffers. `groupPeak` is the Group's physical high-water mark,
including Load. These figures describe this allocator's requests, not resident
memory or allocation by the default Zig allocator.

For collecting and single-item writes over growing Lists, use:

```sh
python3 bench/zig/list-scaling.py <before-host> --out <before.json>
python3 bench/zig/list-scaling.py <after-host> --compare <before.json> --out <after.json>
```

This sweeps 100, 300, 1,000 and 3,000 items for scalar collecting, collecting
List literals containing a spread, and 128 writes to the last item with the
original retained as a Constant built during Load. Each run checks output; `--compare` also checks Fuel and
logical allocation against the saved baseline. Counting-allocator probes run
separately from default-allocator timings, with the same boundaries above.

To distinguish retained originals, aliases renewed at every write, collected
versions, `finally`-protected writes and nested roots, use:

```sh
python3 bench/zig/local-list-writes.py <before-host> <after-host> --before-revision <sha> --out <results.json>
```

This alternates process order across three pairs and sweeps 8, 100, 1,000 and
3,000 items. It performs 128 replacements per Run, or 64 with every version
collected to stay within the unchanged Allocation Budget. Sources, expected
outputs, Fuel, logical allocation and separate allocation probes accompany
every pair. Passing the same binary twice measures control variability.
The [ownership investigation](results/2026-10-15-zig-local-list-writes.md)
records the rejected temp-retirement fast path and its baseline evidence.

For paired before/after timings and probes across every supported workload,
build two Hosts the same way and run:

```sh
python3 bench/zig/value-allocations.py <before-host> <after-host> --before-revision <sha> --out <results.json>
```

## Workloads

The categories are `core`, `numbers`, `text`, `collections`, `messaging`, `host`, `lifecycle` and `macro`.
Use a category name as the filter, for example `bun run bench --filter numbers`.

- **Numbers:** exact fractional addition, multiplication and division, plus millimetre-to-metre Quantity conversion. Fractional checksums are scaled and rounded to integers. Peers use their native numbers; the chosen binary-exact fractions avoid comparing decimal rounding policies. Quantity peers apply the conversion factor numerically.
- **Text:** repeated concatenation, Character iteration and indexing, and finding maximal digit runs. The comparison inputs are ASCII, where the peers' character APIs agree. `text/graphemes` separately exercises NFC, a ZWJ family, a combining mark and a flag on all three Cores; peers skip it because the pinned languages have no shared grapheme API. Starlark and AppleScript have no regular-expression library, so their digit-run ports scan characters.
- **Collections:** List and Map construction, updates with a retained original, and iteration. `list-build` uses `collecting`; `list-append` grows a Script Variable with `put … after` while retaining its initial List. Peers copy the original once before mutating their working collection. This preserves the same value semantics while using each language's idioms. AppleScript's records can't take keys chosen at run time, so its map ports use Foundation's `NSMutableDictionary`. Its ports that grow long lists keep them in a script object's properties, the usual way to avoid reads that slow down as a local list grows.
- **Messaging and scheduling:** sends to another Script, sends that climb a Host Object's parents to their Owning Script, Joins of eight sends, and a zero `wait` in every iteration. Each send waits for its reply, so it also suspends and resumes the sender. The `partner` Host loads [`messaging/partner.talk`](scripts/messaging/partner.talk), which only echoes, beside the Benchmark. The `parents` Host makes a leaf, branch and root Host Object, with the Benchmark as the root's Owning Script. Only the Cores run these workloads.
- **Host boundary:** immediate identity Operations, suspending identity Operations, Host Object property reads, nested Map/List conversion through JSON, and an empty-Handler Delivery/Pump round trip. Only the Cores run these workloads. The manifest's `host` field selects the bindings installed by each Host. Operations and the property read declare one Fuel, with the same Shapes on both Hosts. Suspended calls queue their answer during Start; each answer is consumed by a subsequent Pump, with no external I/O or timer. Host setup is included in Load and excluded from Run. The empty Handler uses N = 1 and is deliberately below the 10–100 ms size target so it measures one Pump.
- **Lifecycle:** Loading a small and a large Script, Save and Restore, and a Segment rolled back after a Limit Fault. Only the Cores run these workloads. For `load-small` and `load-large`, Load median is the measurement, and their Runs are as short as `host/pump`'s. The `restore` Host fills the Script's rows once, outside the Run. Each Run then saves the Group, restores it into a new Group, and delivers `run` to the restored Script. Save and Restore charge no Fuel, so this Benchmark sets `"outlier": false`. In `rollback`, each of N Runs increments a Script Variable and then starts a Join one member wider than `MaxJoin`. Each Limit Fault rolls the increment back, and the sender catches the `send failed` error. The Join Members are the `suspending` Host's identity Operation, so the members that start before the fault leave no work in another Script.
- **Macro workloads:** transforming invoice rows and aggregating amounts, building a formatted text report, and calling a game-tick Handler that advances an actor's position. Report peers use a builder or join; game peers use native records or mutable objects.
- **Fuel Slice sweep:** `core/fib` also runs with a Fuel Slice of 10, 100, 1,000 and 10,000, as `core/fib@slice=<k>`, so its Runs are preempted and resumed across many Pumps. Fuel is the same at every slice, so comparing the run times with unsliced `core/fib` shows the cost of preemption. `--filter @slice` selects the sweep alone.

## Layout

| Path                                             | Contents                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`scripts/`](scripts/)                           | The Benchmark Scripts, one `.talk` file each, and [`benchmarks.json`](scripts/benchmarks.json), their manifest.                                                                                         |
| [`go/`](go/)                                     | The Go runner: a separate module, so benchmark dependencies never enter the Go embedding's `go.mod`.                                                                                                    |
| [`zig/`](zig/)                                   | The native C Host over the Zig Core, driven by `ts/src/measure-zig.ts`.                                                                                                                                 |
| [`ts/`](ts/)                                     | The TS runner with [mitata](https://github.com/evanwashere/mitata), and `bun run bench` itself.                                                                                                         |
| [`peers/`](peers/)                               | Each Benchmark's port in each Peer Language, as `<language>/<category>/<name>.<ext>`, and the CPython runner.                                                                                           |
| [`message-layer/elixir/`](message-layer/elixir/) | An Elixir Host that measures the Zig Core's Message Layer over Wasmex and the native sidecar, for [#532](https://github.com/odogono/odgn-talk/issues/532). It runs on its own, outside `bun run bench`. |
| [`results/`](results/)                           | Committed results, one pair of files per run, and [what each recorded](results/README.md).                                                                                                              |

## Adding a Benchmark

Write `scripts/<category>/<name>.talk` with a Handler `on run n` that returns a value, and add it to the manifest:

```json
{
  "name": "core/fib",
  "n": 15,
  "expect": "610",
  "smoke": { "n": 10, "expect": "55" }
}
```

`expect` is the display form of the value `run n` returns. Choose `n` so that one Run takes 10–100 ms on the slower Core, and the smoke `n` so it takes about a millisecond. A Benchmark one Core can't run yet names it with a reason, as `"skip": { "go": "Joins are not implemented" }`, and the report lists it as skipped.

Optional fields:

- **`host`** names what the runners set up before Load: `immediate`, `suspending`, `properties` or `conversion` for the Host boundary bindings, `partner` or `parents` for messaging, and `restore` for Save and Restore. Each Core's runner sets up the same ones.
- **`slices`** lists the Fuel Slices to sweep. Each one adds a Benchmark named `<name>@slice=<k>` that only the Cores run.
- **`"outlier": false`** keeps a Benchmark whose time is mostly spent outside Fuel-charged work out of the Cost Model outliers.

Then port it to each Peer Language under `peers/`: Lua, Starlark, JavaScript, Python, AppleScript, Go and TS. Each port defines `run(n)`, which must return a value whose display form is `expect`. AppleScript writes it as `on |run|(n)`, because `run` names a script's own run handler. A Benchmark without a counterpart in the Peer Languages, such as one that crosses the Host boundary, says so as `"skip": { "peers": "..." }`. Otherwise a missing port fails the run.

`bun test` in `ts/` and `go test ./...` in `go/` check every Benchmark's smoke output on their Core and every port on their Host's Peer Languages. `uv run --no-project --managed-python python -m unittest` in `peers/python/` checks the Python ports. On macOS, `bun test` in `ts/` also checks the AppleScript ports.

`go -C bench/go test -run TestCoreRunAllocationBudgets` checks the four full-size
core workloads against host-allocation ceilings about 1.5 times their bytes per
Run after #592, and pins their output and Fuel. It also checks `collections/list-build`,
`collections/list-append` and `collections/map-build` against 8 MB, 16 MB and
1 MB ceilings respectively, with their output, Fuel and logical allocation pinned.
The full-size `lifecycle/restore` Run is also held below 20 MB of Host
allocation, with 8,015 Fuel and 8,024 bytes of logical allocation pinned (#504).
Timing comparisons remain advisory.

## Peer Languages

Each port is idiomatic rather than a literal translation of the Script, so that it shows what a user of that language would see. Native Go and TS are the ceilings for their Cores. No runner uses a JIT except native TS on Bun.

| Runner        | Language                                       | Host                    | Pinned by                      |
| ------------- | ---------------------------------------------- | ----------------------- | ------------------------------ |
| `go-native`   | Go                                             | Go                      | `go/go.mod`                    |
| `gopher-lua`  | Lua 5.1                                        | Go                      | `go/go.mod`                    |
| `starlark-go` | Starlark                                       | Go                      | `go/go.mod`                    |
| `ts-native`   | TS                                             | Bun                     | Bun's version                  |
| `wasmoon`     | Lua 5.4, compiled to WebAssembly               | Bun                     | `ts/package.json`              |
| `quickjs`     | JavaScript on QuickJS, compiled to WebAssembly | Bun                     | `ts/package.json`              |
| `cpython`     | Python                                         | CPython, through uv     | `peers/python/.python-version` |
| `applescript` | AppleScript                                    | `osascript`, macOS only | The macOS version              |

Starting the interpreter and compiling the port happen before timing, so a Run is one call of `run(n)`. A runner first checks that one Run produces `expect`, and a wrong output fails the run. The Go runners are the `BenchmarkPeer` benchmarks in `go/`. CPython is timed in-process with `perf_counter_ns`: each repeat calls `run(n)` for at least 50 ms, as `timeit` does. AppleScript is timed the same way in-process, with Foundation's `systemUptime`.

## What is measured

Each runner first runs a Benchmark once and confirms it completes with its expected output. It then times two phases:

- **Load:** parsing, checking and lowering the Script into a new Group. Each Load uses a fresh Script name, so the Core's compile cache never hits.
- **Run:** one `run n` Delivery, and all Pumps until its Run has ended and the Group is idle, on a Script that is already loaded. Each Pump has unlimited Fuel, except in the Fuel Slice sweep. Non-suspending Scripts complete in one Pump. `host/suspending` and `messaging/suspend` take another Pump for each queued answer or zero wait. Limits are set to their conformance minimums, so none trips, except the Join width limit `lifecycle/rollback` exceeds on purpose.

| Column              | Meaning                                                                                                                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load median         | Median time to Load, in µs.                                                                                                                                                                                                                                                                                                       |
| Run median, Run min | Median and fastest Run, in ms.                                                                                                                                                                                                                                                                                                    |
| Fuel                | The Fuel the Group's Pumps use for one Run, including the Runs it starts in other Scripts. It is the same on every Host.                                                                                                                                                                                                          |
| ns/Fuel             | Run median divided by Fuel: what one unit of the Cost Model's work costs on this Core.                                                                                                                                                                                                                                            |
| Logical alloc       | The allocation of the Run and of the Runs it starts, as the Allocation Budget counts it.                                                                                                                                                                                                                                          |
| Host bytes          | Go: bytes allocated per Run (`-benchmem`). TS: the average growth in Bun's heap across a sample, after collection. CPython: the peak one Run holds, as `tracemalloc` traces it. None of these are comparable. The WebAssembly peers allocate inside their own memory and report nothing, and AppleScript has no way to report it. |
| Host allocs         | Go only: allocations per Run.                                                                                                                                                                                                                                                                                                     |

A Peer Language has no Fuel and no timed Load, so it reports only Run times and host allocation. JSON summaries also retain each phase's maximum sample time and sample count; older saved reports may contain only the minimum and median.

**Cost Model outliers** are Benchmarks whose ns/Fuel is more than the outlier factor times the median of the same runner's. They point at operations whose Fuel charge is low for their real cost, or at slow paths in a Core. They are advisory: a reweighting goes through the Spec, never through this suite.

## Profiling

For the TS Core, profile the runner that Bun times:

```sh
bun run bench:profile lifecycle/load-large [--top 25]
```

It prints the TS Core's hottest functions by self time, with file and line, leaving out mitata and native frames. The full Markdown profile, with call trees and per-function details, is saved under `.cache/profiles/`, and the command prints its path. Profiles include the runner's warm-up, so take timings from [`bench:compare`](#comparing-a-branch-with-main) rather than from a profile.

The Go runner is an ordinary `testing.B` benchmark, so the Go tools work on it directly:

```sh
cd bench/go
NORTHTALK_BENCH_FILTER=core/loop go test -run '^$' -bench Run -cpuprofile cpu.out
go tool pprof -top cpu.out
```

`NORTHTALK_BENCH_SMOKE=1` runs at the smoke sizes. Several `-count` runs can be compared with `benchstat`.

## TS snapshot sizes

`bun bench/ts/src/snapshots.ts --samples=30` writes JSON measurements for native
TS embedded-source and external-source snapshots. Each row reports raw bytes,
base64 characters, serialized graph bytes, and separate median Save/Restore
milliseconds after five warmups. Restore includes checksum checks, source
loading and state validation; it does not Pump or settle pending calls.

The controlled synthetic workload has six Scripts with 19,002 source characters
and repeated UI declarations. It measures no active Runs, suspended Capability
messages, timed waits, and concurrent Runs. Separate fixtures vary Script count,
source length (padding the same declarations), Operation count and retained rows.
These are not Mercenary production measurements. Source-size independence is
also tested using comments alone in the Core regression suite.

For a baseline, run the same benchmark file in a checkout of the baseline
revision with `--baseline`, which measures its default save mode. Archive the
entire TS source tree: copying only `group.ts` does not capture codec changes.
Run baseline and candidate sequentially without concurrent tests or builds.

To exercise the same native embedding under Node:

```sh
bun build bench/ts/src/snapshots.ts --target=node --outfile=.cache/snapshots.mjs
node .cache/snapshots.mjs --samples=3
```

The [#1337 results](results/ts-snapshots-1337/README.md) include raw baseline and
candidate measurements, graph reductions and runtime details.
