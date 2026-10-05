# Benchmark Suite

Measures how fast each Core runs the same Scripts, to find slow paths and to compare NorthTalk with its Peer Languages. Nothing here is normative. [ADR 0054](../docs/adr/0054-benchmarks-live-outside-the-cores-and-only-advise-the-cost-model.md) records why the suite lives outside the Cores and only advises the Cost Model. [#314](https://github.com/odogono/odgn-talk/issues/314) tracks the remaining categories and the Peer Language runners.

```sh
bun run bench [--filter <text>] [--only go|ts] [--count <n>] [--smoke] [--no-save] [--outlier-factor <k>]
```

- **`--filter`** keeps the Benchmarks whose names contain the text, such as `core` or `core/fib`.
- **`--only`** runs one Core. With both Cores, a Benchmark whose Fuel differs between them fails the run.
- **`--count`** is the Go `-count`, 10 by default. mitata picks the TS sample count.
- **`--smoke`** runs each Benchmark once at its smoke size and checks output and Fuel parity, without saving anything. Its timings mean nothing.
- **`--no-save`** prints the report without writing it to `results/`.
- **`--outlier-factor`** sets the Cost Model outlier threshold, 3 by default.
- **Exit codes:** 0 when every Benchmark produced its expected output and Fuel agreed, 1 otherwise.

A full run takes about two minutes. It prints a Markdown report and writes it, with the JSON it came from, to `results/<date>-<os>-<arch>-<cpu>.{md,json}`. Each file records the commit, machine, and Bun, Go, language and Cost Model versions.

## Layout

| Path | Contents |
| --- | --- |
| [`scripts/`](scripts/) | The Benchmark Scripts, one `.talk` file each, and [`benchmarks.json`](scripts/benchmarks.json), their manifest. |
| [`go/`](go/) | The Go runner: a separate module, so benchmark dependencies never enter the Go Core's `go.mod`. |
| [`ts/`](ts/) | The TS runner with [mitata](https://github.com/evanwashere/mitata), and `bun run bench` itself. |
| `results/` | Committed results, one pair of files per run. |

## Adding a Benchmark

Write `scripts/<category>/<name>.talk` with a Handler `on run n` that returns a value, and add it to the manifest:

```json
{ "name": "core/fib", "n": 15, "expect": "610", "smoke": { "n": 10, "expect": "55" } }
```

`expect` is the display form of the value `run n` returns. Choose `n` so that one Run takes 10–100 ms on the slower Core, and the smoke `n` so it takes about a millisecond. A Benchmark one Core can't run yet names it with a reason, as `"skip": { "go": "Joins are not implemented" }`, and the report lists it as skipped.

`bun test` in `ts/` and `go test ./...` in `go/` check every Benchmark's smoke output on their Core.

## What is measured

Each runner first runs a Benchmark once and confirms it completes with its expected output. It then times two phases:

- **Load:** parsing, checking and lowering the Script into a new Group. Each Load uses a fresh Script name, so the Core's compile cache never hits.
- **Run:** one `run n` Delivery and the Pump that runs it to completion, on a Script that is already loaded, in one unlimited Fuel Slice. Limits are set to their conformance minimums, so none trips.

| Column | Meaning |
| --- | --- |
| Load median | Median time to Load, in µs. |
| Run median, Run min | Median and fastest Run, in ms. |
| Fuel | The Fuel one Run uses. It is the same on every Host. |
| ns/Fuel | Run median divided by Fuel: what one unit of the Cost Model's work costs on this Core. |
| Logical alloc | The Run's allocation as the Allocation Budget counts it. |
| Host bytes | Go: bytes allocated per Run (`-benchmem`). TS: the average growth in Bun's heap across a sample, after collection. The two are not comparable. |
| Host allocs | Go only: allocations per Run. |

**Cost Model outliers** are Benchmarks whose ns/Fuel is more than the outlier factor times the median of the same runner's. They point at operations whose Fuel charge is low for their real cost, or at slow paths in a Core. They are advisory: a reweighting goes through the Spec, never through this suite.

## Profiling

The Go runner is an ordinary `testing.B` benchmark, so the Go tools work on it directly:

```sh
cd bench/go
NORTHTALK_BENCH_FILTER=core/loop go test -run '^$' -bench Run -cpuprofile cpu.out
go tool pprof -top cpu.out
```

`NORTHTALK_BENCH_SMOKE=1` runs at the smoke sizes. Several `-count` runs can be compared with `benchstat`.
