# Benchmark Suite

Measures how fast each Core runs the same Scripts, to find slow paths and to compare NorthTalk with its Peer Languages. Nothing here is normative. [ADR 0054](../docs/adr/0054-benchmarks-live-outside-the-cores-and-only-advise-the-cost-model.md) records why the suite lives outside the Cores and only advises the Cost Model. [#314](https://github.com/odogono/odgn-talk/issues/314) tracks the remaining categories.

```sh
bun run bench [--filter <text>] [--only go|ts|peers] [--count <n>] [--smoke] [--no-save] [--outlier-factor <k>]
```

- **`--filter`** keeps the Benchmarks whose names contain the text, such as `core` or `core/fib`.
- **`--only`** runs one Core, or only the [Peer Languages](#peer-languages). With both Cores, a Benchmark whose Fuel differs between them fails the run.
- **`--count`** is the Go `-count` and the number of CPython repeats, 10 by default. mitata picks the sample count on Bun.
- **`--smoke`** runs each Benchmark once at its smoke size and checks output and Fuel parity, without saving anything. Its timings mean nothing.
- **`--no-save`** prints the report without writing it to `results/`.
- **`--outlier-factor`** sets the Cost Model outlier threshold, 3 by default.
- **Exit codes:** 0 when every Benchmark and every port produced its expected output and Fuel agreed, 1 otherwise.

The Peer Languages need [uv](https://docs.astral.sh/uv/), which downloads the pinned CPython on first use. A full wave 1 run takes about 20–30 minutes with the default ten Go samples. It prints a Markdown report and writes it, with the JSON it came from, to `results/<date>-<os>-<arch>-<cpu>.{md,json}`. Each file records the commit, machine, and Bun, Go, language, Cost Model and Peer Language versions.

## Workloads

Wave 1 includes `core`, `numbers`, `text`, `collections`, `host` and `macro`.
Use a category name as the filter, for example `bun run bench --filter numbers`.

- **Numbers:** exact fractional addition, multiplication and division, plus millimetre-to-metre Quantity conversion. Fractional checksums are scaled and rounded to integers. Peers use their native numbers; the chosen binary-exact fractions avoid comparing decimal rounding policies. Quantity peers apply the conversion factor numerically.
- **Text:** repeated concatenation, Character iteration and indexing, and finding maximal digit runs. The comparison inputs are ASCII, where the peers' character APIs agree. `text/graphemes` separately exercises NFC, a ZWJ family, a combining mark and a flag on both Cores; peers skip it because the pinned languages have no shared grapheme API. Starlark has no regular-expression library, so its digit-run port scans characters.
- **Collections:** List and Map construction, updates with a retained original, and iteration. Peers copy the original once before mutating their working collection. This preserves the same value semantics while using each language's idioms.
- **Host boundary:** immediate identity Operations, suspending identity Operations, Host Object property reads, nested Map/List conversion through JSON, and an empty-Handler Delivery/Pump round trip. Only the Cores run these workloads. The manifest's `host` field selects the bindings installed by each Host. Operations and the property read declare one Fuel, with the same Shapes on both Hosts. Suspended calls queue their answer during Start; each answer is consumed by a subsequent Pump, with no external I/O or timer. Host setup is included in Load and excluded from Run. The empty Handler uses N = 1 and is deliberately below the 10–100 ms size target so it measures one Pump.
- **Macro workloads:** transforming invoice rows and aggregating amounts, building a formatted text report, and calling a game-tick Handler that advances an actor's position. Report peers use a builder or join; game peers use native records or mutable objects.

Messaging and lifecycle workloads remain wave 2; [#314](https://github.com/odogono/odgn-talk/issues/314) tracks those categories.

## Layout

| Path | Contents |
| --- | --- |
| [`scripts/`](scripts/) | The Benchmark Scripts, one `.talk` file each, and [`benchmarks.json`](scripts/benchmarks.json), their manifest. |
| [`go/`](go/) | The Go runner: a separate module, so benchmark dependencies never enter the Go Core's `go.mod`. |
| [`ts/`](ts/) | The TS runner with [mitata](https://github.com/evanwashere/mitata), and `bun run bench` itself. |
| [`peers/`](peers/) | Each Benchmark's port in each Peer Language, as `<language>/<category>/<name>.<ext>`, and the CPython runner. |
| `results/` | Committed results, one pair of files per run. |

## Adding a Benchmark

Write `scripts/<category>/<name>.talk` with a Handler `on run n` that returns a value, and add it to the manifest:

```json
{ "name": "core/fib", "n": 15, "expect": "610", "smoke": { "n": 10, "expect": "55" } }
```

`expect` is the display form of the value `run n` returns. Choose `n` so that one Run takes 10–100 ms on the slower Core, and the smoke `n` so it takes about a millisecond. A Benchmark one Core can't run yet names it with a reason, as `"skip": { "go": "Joins are not implemented" }`, and the report lists it as skipped.

Then port it to each Peer Language under `peers/`: Lua, Starlark, JavaScript, Python, Go and TS. Each port defines `run(n)`, which must return a value whose display form is `expect`. A Benchmark without a counterpart in the Peer Languages, such as one that crosses the Host boundary, says so as `"skip": { "peers": "..." }`. Otherwise a missing port fails the run.

`bun test` in `ts/` and `go test ./...` in `go/` check every Benchmark's smoke output on their Core and every port on their Host's Peer Languages. `uv run --no-project --managed-python python -m unittest` in `peers/python/` checks the Python ports.

## Peer Languages

Each port is idiomatic rather than a literal translation of the Script, so that it shows what a user of that language would see. Native Go and TS are the ceilings for their Cores. No runner uses a JIT except native TS on Bun.

| Runner | Language | Host | Pinned by |
| --- | --- | --- | --- |
| `go-native` | Go | Go | `go/go.mod` |
| `gopher-lua` | Lua 5.1 | Go | `go/go.mod` |
| `starlark-go` | Starlark | Go | `go/go.mod` |
| `ts-native` | TS | Bun | Bun's version |
| `wasmoon` | Lua 5.4, compiled to WebAssembly | Bun | `ts/package.json` |
| `quickjs` | JavaScript on QuickJS, compiled to WebAssembly | Bun | `ts/package.json` |
| `cpython` | Python | CPython, through uv | `peers/python/.python-version` |

Starting the interpreter and compiling the port happen before timing, so a Run is one call of `run(n)`. A runner first checks that one Run produces `expect`, and a wrong output fails the run. The Go runners are the `BenchmarkPeer` benchmarks in `go/`. CPython is timed in-process with `perf_counter_ns`: each repeat calls `run(n)` for at least 50 ms, as `timeit` does.

## What is measured

Each runner first runs a Benchmark once and confirms it completes with its expected output. It then times two phases:

- **Load:** parsing, checking and lowering the Script into a new Group. Each Load uses a fresh Script name, so the Core's compile cache never hits.
- **Run:** one `run n` Delivery and all Pumps through its RunEnd, on a Script that is already loaded, with unlimited Fuel per Pump. Non-suspending Scripts complete in one Pump; `host/suspending` uses a subsequent Pump for each queued answer. Limits are set to their conformance minimums, so none trips.

| Column | Meaning |
| --- | --- |
| Load median | Median time to Load, in µs. |
| Run median, Run min | Median and fastest Run, in ms. |
| Fuel | The Fuel one Run uses. It is the same on every Host. |
| ns/Fuel | Run median divided by Fuel: what one unit of the Cost Model's work costs on this Core. |
| Logical alloc | The Run's allocation as the Allocation Budget counts it. |
| Host bytes | Go: bytes allocated per Run (`-benchmem`). TS: the average growth in Bun's heap across a sample, after collection. CPython: the peak one Run holds, as `tracemalloc` traces it. None of these are comparable. The WebAssembly peers allocate inside their own memory and report nothing. |
| Host allocs | Go only: allocations per Run. |

A Peer Language has no Fuel and no timed Load, so it reports only Run times and host allocation.

**Cost Model outliers** are Benchmarks whose ns/Fuel is more than the outlier factor times the median of the same runner's. They point at operations whose Fuel charge is low for their real cost, or at slow paths in a Core. They are advisory: a reweighting goes through the Spec, never through this suite.

## Profiling

The Go runner is an ordinary `testing.B` benchmark, so the Go tools work on it directly:

```sh
cd bench/go
NORTHTALK_BENCH_FILTER=core/loop go test -run '^$' -bench Run -cpuprofile cpu.out
go tool pprof -top cpu.out
```

`NORTHTALK_BENCH_SMOKE=1` runs at the smoke sizes. Several `-count` runs can be compared with `benchstat`.
