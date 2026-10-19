# Replacing the Go Core: first binding investigation

Evidence recorded on 2026-10-14 for [#884](https://github.com/odogono/odgn-talk/issues/884),
against `34c990976c5b863b7791bc64c8ac760c263e2e9d`. The
[reproducible probe](../../spikes/go-zig-binding/README.md) embeds a Zig WASI
reactor and executes it through wazero. **The original investigation failed its first compatibility gate;
follow-up Stop parity is described below. The Go Core remains supported.**

## Confirming run after the binary callback envelope, 2026-10-19

A second `go-zig-bench` dispatch measured `main` at
`3b9e67add4344b52853b3f66ba0946a06d383047`:
[run 39250561088](https://github.com/odogono/odgn-talk/actions/runs/39250561088).
That head adds only TypeScript, Elixir, workflow and documentation changes to
the first run's `f8644caf`; `impl/go`, `impl/zig`, `bench/go` and `spikes`
are unchanged. The artifact (sha256 `fb70d30d…`), Request/Pump base, Go and
wazero versions match the first run, so the two runs satisfy the
[Request/Pump protocol](request-pump-binary.md#measurement-protocol-1278).
Raw results and environment records are archived under
[`2026-10-19-ci-after-1311-run2`](../../bench/results/go-zig-adapter/2026-10-19-ci-after-1311-run2/).

The runner CPUs swapped on amd64: Request/Pump ran on an AMD EPYC 9V74 and
the full suite on an Intel Xeon Platinum 8573C, the reverse of the first run.

### Paired Request results, both runs

Medians of ten paired round ratios, run 1 / run 2:

| Workload | Limit | Linux amd64 | Linux arm64 | macOS arm64 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Fields Request / native Request | ≤ 3× | 2.310 / 2.590× | 2.614 / 2.707× | 2.727 / 2.451× | Pass in both |
| Fields combined / native combined | ≤ 3× | 1.992 / 2.173× | 2.256 / 2.239× | 2.402 / 2.197× | Pass in both |
| Fields Request / JSON Request | ≤ 0.75× | 0.481 / 0.489× | 0.484 / 0.511× | 0.487 / 0.505× | Pass in both |
| Native Request / base Request | no slowdown | 0.976 / 1.002× | 0.990 / 0.992× | 0.996 / 0.995× | Pass in both |

### Full-suite limits, both runs

Run 1 / run 2, ratios of the five-sample medians within each job, except the
absolute cold-start time:

| Workload | Limit | Linux amd64 | Linux arm64 | macOS arm64 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| `host/immediate`, `host/properties`, `host/pump` | ≤ 3× | 3.77–7.06 / 3.13–3.85× | 2.86–4.79 / 2.75–4.66× | 3.33–3.81 / 2.53–3.72× | Miss in both |
| `host/conversion` | ≤ 3× | 3.13 / 1.95× | 2.02 / 1.95× | 2.02 / 1.62× | Mixed on amd64; pass in both elsewhere |
| `BackendDeferredCall/history=0` | ≤ 3× | 4.85 / 4.00× | 8.04 / 6.93× | 3.82 / 4.51× | Miss in both |
| `messaging/*` | ≤ 2× | 0.75–1.73 / 0.79–1.20× | 0.62–1.15 / 0.63–1.10× | 0.68–1.60 / 0.76–2.06× | Mixed on macOS; pass in both on Linux |
| `BackendMultiGroup/groups=16` req/s | ≥ 0.5× | 0.62 / 0.89× | 0.68 / 0.67× | 1.40 / 1.70× | Pass in both |
| `BackendRequest` p99 | ≤ 3× | 1.25 / 0.75× | 1.43 / 1.34× | 4.00 / 2.00× | Mixed on macOS; pass in both on Linux |
| `Load/core/loop` | ≤ 3× | 3.79 / 3.13× | 4.51 / 4.56× | 2.37 / 1.80× | Miss in both on Linux; pass in both on macOS |
| `GroupInstantiation` | ≤ 10× | 9.35 / 9.22× | 9.28 / 9.12× | 9.79 / 7.12× | Pass in both, close to the limit |
| `BackendRetainedMemory` heap/Group | ≤ 4× | 1.70 / 1.70× | 1.70 / 1.70× | 1.70 / 1.70× | Pass in both |
| `BackendColdStart/cache=warm` first Group | ≤ 250 ms | 52.6 / 51.5 ms | 47.0 / 46.8 ms | 78.2 / 60.7 ms | Pass in both |

The `host/*` ranges include `host/suspending`. In run 2, `BackendRequest` mean
time is 2.19×, 2.99× and 3.35× native, and the whole cold-start process with
a warm cache takes 56.1, 51.8 and 70.9 ms.

**#1103 remains incomplete.** The paired Request goal, 16-Group throughput,
Group instantiation, retained memory and cold start pass in both runs on
every job and are accepted. Host callbacks, deferred calls, Linux
`Load/core/loop` and rollback miss in both. Three results are mixed:

- amd64 `host/conversion` passes in run 2 (1.95×) after 3.13× in run 1; the
  full-suite job changed from AMD EPYC 7763 to Intel Xeon, so a third run on
  the same CPU is needed to settle it.
- macOS `BackendRequest` p99 is 2.00× (159.9 µs against 80.0 µs), so run 1's
  4.00× did not repeat. It passes in run 2 only because native's p99 also
  rose; Zig's p99 fell from 186.0 µs to 159.9 µs.
- macOS `messaging/suspend` misses at 2.06× in run 2 after 1.60× in run 1.
  The other messaging rows stay at or below 0.97× (amd64), 0.79× (arm64)
  and 1.01× (macOS) in both runs.

The other original #1054 limits, run 1 / run 2:

| Workload | Limit | Linux amd64 | Linux arm64 | macOS arm64 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Warm execution, worst core/collections/macro Run, excluding `fib@slice` | ≤ 2× | 1.52 / 1.58× | 1.16 / 1.14× | 1.17 / 1.08× | Pass in both |
| `lifecycle/restore` | ≤ 1.5× | 0.17 / 0.19× | 0.18 / 0.16× | 0.15 / 0.14× | Pass in both |
| `lifecycle/load-large` | ≤ 2.5× | 1.15 / 1.08× | 0.94 / 0.93× | 0.94 / 0.94× | Pass in both |
| Zig deferred `history=5000` / `history=0` | ≤ 1.2× | 1.08 / 1.00× | 0.90 / 1.07× | 0.91 / 0.96× | Pass in both |
| `lifecycle/rollback` | ≤ 2× | 4.84 / 3.62× | 4.75 / 4.65× | 4.05 / 4.04× | Miss in both |

Fuel and logical bytes match native on every Run in all three run-2
full-suite jobs. The first Group without a compilation cache takes
1.58–1.83 s.

## Remeasurement after the binary callback envelope, 2026-10-19

After #1313 (#1311, the `callbacks-fields-v1` host callback envelope)
merged, one `go-zig-bench` dispatch measured `main` at
`f8644cafc280b91509a438bdf9dfe9a9d275fb9d`:
[run 39245400361](https://github.com/odogono/odgn-talk/actions/runs/39245400361).
It also includes #1312's callback integer and clock decoding. The artifact
source is `aba5110c3642082e3ea0236bfdc050130d03d71d`, Zig 0.17.0,
wasm32-wasi, safe, sha256
`fb70d30dad2b98414d56ad7f11fd6fd1c9b84568c966328d6fed3caf76066c3f`. The run
uses Go 1.27.2, wazero v1.12.0 and `CGO_ENABLED=0`; the Request/Pump base is
`ff543e29af2164f477c1d013fb2df19a0079d14b`. Raw results and environment
records are archived under
[`2026-10-19-ci-after-1311`](../../bench/results/go-zig-adapter/2026-10-19-ci-after-1311/).

This is a single run. The
[Request/Pump protocol](request-pump-binary.md#measurement-protocol-1278)
needs two runs at the same head, base and artifact before a result near a
limit counts as accepted, so the passes below are evidence, not acceptance.

### Paired Request results

Medians of ten paired round ratios, each against native from the same job:

| Workload | Limit | Linux amd64 | Linux arm64 | macOS arm64 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Fields Request / native Request | ≤ 3× | 2.310× | 2.614× | 2.727× | Pass in this run |
| Fields combined / native combined | ≤ 3× | 1.992× | 2.256× | 2.402× | Pass in this run |
| Fields Request / JSON Request | ≤ 0.75× | 0.481× | 0.484× | 0.487× | Pass |
| Native Request / base Request | no slowdown | 0.976× | 0.990× | 0.996× | Pass |

Linux amd64 Request/Pump ran on an Intel Xeon Platinum 8573C; the
full-suite amd64 job ran on an AMD EPYC 7763. The earlier runs showed a 28%
amd64 swing across runner CPUs, so a second run is needed before the amd64
Request pass is accepted.

### Full-suite limits

Ratios of the five-sample medians within each full-suite job, except the
absolute cold-start time.

| Workload | Limit | Linux amd64 | Linux arm64 | macOS arm64 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| `host/immediate`, `host/properties`, `host/pump` | ≤ 3× | 3.77–7.06× | 2.86–4.79× | 3.33–3.81× | Miss |
| `host/conversion` | ≤ 3× | 3.13× | 2.02× | 2.02× | Miss on amd64 |
| `BackendDeferredCall/history=0` | ≤ 3× | 4.85× | 8.04× | 3.82× | Miss |
| `messaging/*` | ≤ 2× | 0.75–1.73× | 0.62–1.15× | 0.68–1.60× | Pass |
| `BackendMultiGroup/groups=16` req/s | ≥ 0.5× | 0.62× | 0.68× | 1.40× | Pass |
| `BackendRequest` p99 | ≤ 3× | 1.25× | 1.43× | 4.00× | Miss on macOS |
| `Load/core/loop` | ≤ 3× | 3.79× | 4.51× | 2.37× | Miss on Linux |
| `GroupInstantiation` | ≤ 10× | 9.35× | 9.28× | 9.79× | Pass, close to the limit |
| `BackendRetainedMemory` heap/Group | ≤ 4× | 1.70× | 1.70× | 1.70× | Pass |
| `BackendColdStart/cache=warm` first Group | ≤ 250 ms | 52.6 ms | 47.0 ms | 78.2 ms | Pass |

`BackendRequest` mean time is 4.08×, 2.62× and 4.62× native. The whole
cold-start process with a warm cache takes 57.1, 52.6 and 100.1 ms.

**#1103 remains incomplete.** Compared with the two earlier 2026-10-19 runs,
messaging and 16-Group throughput now pass in every job, and the paired
Request goal passes on amd64 for the first time. Host callbacks, deferred
calls, Load and amd64 conversion still miss. macOS `BackendRequest` p99
misses for the first time (186.0 µs against native's 46.5 µs); the earlier
runs measured 0.87–1.68×, so this needs a repeat before it is treated as a
regression. Linux arm64 deferred calls stay the largest gap at 8.04×.

The other original #1054 limits:

| Workload | Limit | Linux amd64 | Linux arm64 | macOS arm64 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Warm execution, worst core/collections/macro Run, excluding `fib@slice` | ≤ 2× | 1.52× | 1.16× | 1.17× | Pass |
| `lifecycle/restore` | ≤ 1.5× | 0.17× | 0.18× | 0.15× | Pass |
| `lifecycle/load-large` | ≤ 2.5× | 1.15× | 0.94× | 0.94× | Pass |
| Zig deferred `history=5000` / `history=0` | ≤ 1.2× | 1.08× | 0.90× | 0.91× | Pass |
| `lifecycle/rollback` | ≤ 2× | 4.84× | 4.75× | 4.05× | Miss |

Fuel and logical bytes match native on every Run in all three full-suite
jobs. The first Group without a compilation cache takes 1.61–2.14 s; this is
recorded, not limited.

## Remeasurement after the merged performance work, 2026-10-19

For [#1103](https://github.com/odogono/odgn-talk/issues/1103), two
`go-zig-bench` dispatches measure current `main`,
`46508d138e5090c7999637eeabb4f8ac6d0fa3b5`:
[run 1](https://github.com/odogono/odgn-talk/actions/runs/39234138486) and
[run 2](https://github.com/odogono/odgn-talk/actions/runs/39234205013).
They include the binary fields default, #1273's guest-cost work, #1287's
callback decoder, #1298's instruction fast path, #1302's List writes and
#1306's numeric work. The artifact source is
`73e91b2a6e515ca7e8fa88e9ff2507f833674648`, Zig 0.17.0, wasm32-wasi, safe,
sha256 `fa24d7b7882ba86d3ab25cf77ca1544bb2c6a5e8954befe6907672a0c4fdf98a`.
Both runs use Go 1.27.2, wazero v1.12.0 and `CGO_ENABLED=0`.

Raw results and environment records are archived under
[`2026-10-19-ci-run1`](../../bench/results/go-zig-adapter/2026-10-19-ci-run1/) and
[`2026-10-19-ci-run2`](../../bench/results/go-zig-adapter/2026-10-19-ci-run2/).
The `go-zig-adapter-*` jobs run the existing five-sample full suite; the
`request-pump-*` jobs run ten interleaved rounds of 20,000 iterations against
native, JSON, map and fields, with native Request at `ff543e29` as a regression
control. Use ratios within a job; these runs do not isolate individual PRs.

### Paired Request results

The [Request/Pump protocol](request-pump-binary.md#measurement-protocol-1278)
requires two runs at the same head, base and artifact for acceptance near a
limit. Each cell below lists run 1 / run 2, using the median of paired round
ratios. The full details and JSON comparisons are in the
[binary research](request-pump-binary.md#remeasurement-after-the-merged-performance-work-2026-10-19).

| Workload | Limit | Linux amd64 | Linux arm64 | macOS arm64 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Fields Request / native Request | ≤ 3× | 3.123× / 4.002× | 2.539× / 2.507× | 2.546× / 2.677× | Miss on amd64 in both runs |
| Fields combined / native combined | ≤ 3× | 2.806× / 3.639× | 2.202× / 2.265× | 2.190× / 2.208× | Miss on amd64 in run 2 |

The ≤3× Request goal remains unmet. The amended ≤0.75×-JSON gate passes for
both workloads in all six jobs: fields takes 0.444–0.551× JSON time for
Request and 0.398–0.506× for combined Request. Native Request shows no
significant slowdown against the base in any job (paired native/base medians
0.970–1.016×); Linux arm64 run 2 improves 0.93% (`p=0.023`). This control
does not establish no regression for every native workload.

Linux amd64 used an Intel Xeon Platinum 8370C in Request/Pump run 1 and an
AMD EPYC 7763 in run 2. The 28% change in Request ratio across identical
source and artifact is a reason to retain both jobs and avoid attributing
cross-run timing changes to an individual optimization.

### Full-suite limits

Each cell lists **run 1 / run 2**. These are ratios of the five-sample
medians within each full-suite job, except the absolute cold-start time.
They are separate from the paired Request assessment above. Host and
messaging ranges cover their individual workloads, not sample variation.
All required platforms and both runs must pass; a split result does not
establish acceptance.

| Workload | Limit | Linux amd64 | Linux arm64 | macOS arm64 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| `host/immediate`, `host/properties`, `host/pump` | ≤ 3× | 3.44–4.93× / 3.77–5.52× | 4.29–4.88× / 4.16–4.74× | 2.96–5.56× / 6.55–9.40× | Miss |
| `host/conversion` | ≤ 3× | 2.72× / 2.96× | 3.14× / 3.04× | 2.31× / 3.86× | Miss |
| `BackendDeferredCall/history=0` | ≤ 3× | 3.24× / 4.16× | 10.92× / 10.65× | 3.73× / 4.15× | Miss |
| `messaging/*` | ≤ 2× | 0.67–1.14× / 0.70–1.20× | 0.61–1.05× / 0.61–1.05× | 0.71–1.61× / 0.97–2.25× | Miss in macOS run 2 |
| `BackendMultiGroup/groups=16` req/s | ≥ 0.5× | 0.70× / 0.67× | 0.41× / 0.39× | 0.68× / 1.01× | Miss on Linux arm64 |
| `BackendRequest` p99 | ≤ 3× | 0.78× / 0.68× | 1.58× / 1.41× | 1.68× / 0.87× | Pass |
| `Load/core/loop` | ≤ 3× | 2.97× / 3.40× | 4.65× / 4.53× | 2.54× / 2.07× | Miss on Linux |
| `GroupInstantiation` | ≤ 10× | 6.66× / 6.99× | 9.19× / 9.56× | 10.48× / 7.36× | Miss in macOS run 1 |
| `BackendRetainedMemory` heap/Group | ≤ 4× | 1.70× / 1.70× | 1.70× / 1.70× | 1.70× / 1.70× | Pass |
| `BackendColdStart/cache=warm` first Group | ≤ 250 ms | 31.9 / 43.0 ms | 47.4 / 47.2 ms | 52.7 / 60.1 ms | Pass |

**#1103 remains incomplete.** Request p99, retained heap and warm-cache
startup pass in every job. The immediate-call category still misses both
the paired Request limit on amd64 and the callback limits above. Conversion,
deferred calls, messaging, throughput, Load and instantiation do not pass
across all required jobs.

Messaging is much closer than the 2026-10-18 recorded range of 1.3–2.4×:
every Linux workload is now at most 1.20× native, but macOS run 2's
`messaging/suspend` is 2.253×. Instantiation likewise needs another improvement
or more investigation: macOS run 1 measures 10.476×, so rounding or retaining
only run 2 would incorrectly turn it into a pass. The persistent Linux arm64
gaps are deferred calls (about 10.7×) and throughput (about 0.4×).

For context, the other original #1054 limits, including #1101's rows:

| Workload | Limit | Linux amd64 | Linux arm64 | macOS arm64 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Warm execution, worst core/collections/macro Run, excluding `fib@slice` | ≤ 2× | 1.43× / 1.51× | 1.15× / 1.14× | 1.04× / 1.41× | Pass |
| `lifecycle/restore` | ≤ 1.5× | 0.16× / 0.18× | 0.16× / 0.16× | 0.12× / 0.17× | Pass |
| `lifecycle/load-large` | ≤ 2.5× | 1.03× / 1.08× | 0.93× / 0.94× | 0.96× / 1.09× | Pass |
| Zig deferred `history=5000` / `history=0` | ≤ 1.2× | 0.99× / 1.00× | 1.01× / 0.98× | 0.94× / 1.01× | Pass |
| `lifecycle/rollback` | ≤ 2× | 3.92× / 4.31× | 5.19× / 5.24× | 3.95× / 5.66× | Miss |

Fuel and logical bytes match native on every Run in all six full-suite jobs.
The first Group without a compilation cache takes 1.12–1.76 s; this is
recorded, not limited. Full-suite jobs measure native and then Zig rather
than interleaving them, and their five samples are insufficient for
benchstat's finite 95% confidence interval. Treat borderline or split results
as unestablished, and do not infer individual-PR speedups or native regressions
from changes against a different runner/job. The controlled native/base
Request comparison is the regression evidence available in this workflow.

### Correctness checks on the measured revision

The following commands pass locally at the measured revision:

```sh
bun install --frozen-lockfile
bun run unicode:check
CGO_ENABLED=0 go -C impl/go test .
CGO_ENABLED=0 impl/go/zig-experimental-check.sh
CGO_ENABLED=0 go -C impl/go run ./cmd/corpus --check-passing
CGO_ENABLED=0 go -C impl/go run -tags talk_zig_experimental ./cmd/corpus --check-passing
```

Both Corpus runners pass the existing gate, including the 446 listed cases.
The selected adapter gate includes embedding, Sessions, facilities and the
current seed, chunked-frame and Library-restore regressions. These checks
do not turn a missed performance limit into an acceptance pass.

## Adapter measurements against native Go, 2026-10-17

[#1054](https://github.com/odogono/odgn-talk/issues/1054) measures the public
adapter behind `talk_zig_experimental` against native Go through the same
public API. [`zig-adapter-bench.sh`](../../impl/go/zig-adapter-bench.sh) runs the
Backend benchmarks in [`backend_bench_test.go`](../../impl/go/backend_bench_test.go),
Group instantiation, and the Benchmark Suite's Load and Run, built once without
and once with the tag. The [`go-zig-bench` workflow](../../.github/workflows/go-zig-bench.yml)
runs it on each platform. All runs use Go 1.27.2, wazero v1.12.0,
`CGO_ENABLED=0`, `-count 5`, and the embedded artifact built from
`079a7c36` by Zig 0.17.0 (wasm32-wasi, ReleaseSafe, sha256
`18c5ac696faa06a5784543b881608c50291b333c20fd556b724f3e039fdb65ee`).

| Platform | Machine | Commit | Results |
|---|---|---|---|
| Linux amd64 | CI, AMD EPYC 7763, 4 vCPU | `55a2d794` (merge of `b7ef6e42`) | [ci-linux-amd64](../../bench/results/go-zig-adapter/2026-10-17-ci-linux-amd64/) |
| Linux arm64 | CI, 4 vCPU | `55a2d794` | [ci-linux-arm64](../../bench/results/go-zig-adapter/2026-10-17-ci-linux-arm64/) |
| macOS arm64 | CI, Apple M1 (virtual), 3 vCPU | `55a2d794` | [ci-darwin-arm64](../../bench/results/go-zig-adapter/2026-10-17-ci-darwin-arm64/) |
| macOS arm64 | Local Apple M5 | `7bb8942d` with the benchmark changes | [darwin-arm64](../../bench/results/go-zig-adapter/2026-10-17-darwin-arm64/) |

Each directory holds `env.txt`, raw output for both backends and a benchstat
`comparison.txt`. Shared runners are noisy, so read results as ratios within
one job. Ratios on the 3–4 vCPU runners are about three times those on the
local machine for every Host crossing, while pure execution is close on both.
GC on fewer spare cores is a likely cause, given the allocation rate below, but
is not confirmed.

### Retirement limits

**Status: agreed by the maintainer on 2026-10-17** and recorded on #1054 and
#884. Limits are Zig-to-native ratios within one job, except cold start. A
limit passes when every CI platform meets it. Three pass. The misses have two
follow-ups: [#1101](https://github.com/odogono/odgn-talk/issues/1101) for
deferred-call age and rollback, and
[#1103](https://github.com/odogono/odgn-talk/issues/1103) for the rest.

| Workload | Measure | Limit | Linux amd64 | Linux arm64 | macOS CI | Result |
|---|---|---|---|---|---|---|
| Warm execution | worst Run of core, collections, macro | ≤ 2× | 1.78× | 1.35× | 1.49× | Pass |
| Restore | `lifecycle/restore` | ≤ 1.5× | 0.20× | 0.19× | 0.19× | Pass |
| Large Load | `lifecycle/load-large` | ≤ 2.5× | 2.09× | 1.56× | 1.74× | Pass |
| Load into a new Group | `Load/core/loop` | ≤ 3× | 23.9× | 19.5× | 17.4× | Miss |
| Group on shared code | `GroupInstantiation` | ≤ 10× | 107× | 84× | 88× | Miss |
| Cold start | first Group in a fresh process | ≤ 250 ms | 1.57 s | 1.40 s | 1.50 s | Miss |
| Immediate Capability call | `BackendRequest`, `host/immediate`, `host/properties`, `host/pump` | ≤ 3× | 16–20× | 11–19× | 11–18× | Miss |
| Value conversion | `host/conversion` | ≤ 3× | 7.5× | 6.2× | 4.8× | Miss |
| Deferred call | `BackendDeferredCall/history=0` | ≤ 3× | 16.7× | 21.7× | 22.8× | Miss |
| Deferred call with age | Zig `history=5000` ÷ `history=0` | ≤ 1.2× | 1.76× | 1.89× | 1.74× | Miss |
| Rollback | `lifecycle/rollback` | ≤ 2× | 108× | 104× | 106× | Miss |
| Messaging | `messaging/*` | ≤ 2× | 2.9–6.9× | 2.6–6.3× | 3.5–5.3× | Miss |
| Multi-Group throughput | `BackendMultiGroup/groups=16` req/s | ≥ 0.5× | 0.20× | 0.19× | 0.26× | Miss |
| Tail latency | `BackendRequest` p99 | ≤ 3× | 11.3× | 8.9× | 10.2× | Miss |
| Retained memory | `BackendRetainedMemory` heap per Group | ≤ 4× | 38× | 31× | 38× | Miss |

The absolute figures behind those ratios, on Linux amd64, native then Zig:

- Request round trip 11.5 µs / 186 µs, p99 59 µs / 669 µs, 89 / 879 allocations.
- Deferred call 33 µs / 552 µs, rising to 974 µs after 5000 earlier calls.
- 16 Groups 40.5k / 8.2k requests per second.
- Group instantiation 11 µs / 1.2 ms, with 6.3 KiB / 5.6 MiB allocated.
- Retained per Group 61 KiB / 2.3 MiB heap.
- Cold start: first Group 0.23 ms / 1.57 s, a second Group on the same Core
  56 µs / 1.39 ms.

A slice-heavy Run multiplies the crossing cost: `fib@slice=10` is 19–27×, falling
to 1.5–2.7× at `slice=1000`.

### Hotspots

Profiles from the local run explain the misses in four groups. The second is
#1101; #1103 covers the other three.

1. **Message Layer crossing.** This covers immediate and deferred calls,
   conversion, messaging, throughput, tail latency and short slices. On
   `BackendRequest`, Go-side JSON decoding is about 43% of the caller path and
   encoding about 13%; the guest frame itself is about 17%. Each request
   allocates about 170 KB. About 68% of that is wazero call-engine churn,
   because [`reactor.go`](../../impl/go/internal/zigwasm/reactor.go) looks up
   `talk_buffer` and `talk_send` on every frame, and GC takes about 45% of CPU.
   Caching those exports cut allocation 3.8× in a local experiment with no
   local time gain, which may differ on the smaller CI runners. JSON remains
   the larger cost; a binary frame or direct WASM exports would remove it.
2. **Retained suspending Calls**, tracked in
   [#1101](https://github.com/odogono/odgn-talk/issues/1101). This covers deferred
   calls with age, `host/suspending` (37–42×) and rollback. The Zig Machine
   keeps every suspending Call until the Group ends and scans that list in
   `isAbandoned`, `writeSettled` and `forgetAbandoned`, so 95% of that time is
   in guest code. Across eight successive Runs, a suspending call grew from
   54 µs to 95 µs and a rollback Run from 2.6 ms to 37 ms, while native Go
   stayed flat.
3. **Per-Group guest.** This covers Load into a new Group, shared-code
   instantiation and retained memory. Each Group instantiates its own guest,
   allocating 5.6 MiB and retaining about 2 MiB of heap once loaded.
4. **Cold compile.** The runtime compiles the ReleaseSafe artifact once per
   process with no compilation cache, so the first Group pays 0.7 s locally and
   1.4–1.6 s on CI. A wazero compilation cache directory or a smaller release
   build are the obvious candidates.

Under #1054, a failed limit blocks adapter expansion until an alternative passes
it: an optimized Message Layer, direct WASM exports, or cgo as an optional
backend only.

### Remeasurement after #1101, 2026-10-18

The same workflow, [run 39088047462](https://github.com/odogono/odgn-talk/actions/runs/39088047462),
on `main` at `21412294`. That includes #1101, and the #1103 changes merged so far:
#1105, #1106, #1107, #1122, #1153 and #1154. The embedded artifact is built from
`19de8411` by Zig 0.17.0 (wasm32-wasi, ReleaseSafe, sha256
`febe1f49da54d22737351379a16eb4c09bca063de0ea6591a07e034784329b30`). The Linux
amd64 runner was an AMD EPYC 9V45, not the 7763 of the first run. Results are in
[ci-linux-amd64](../../bench/results/go-zig-adapter/2026-10-18-ci-linux-amd64/),
[ci-linux-arm64](../../bench/results/go-zig-adapter/2026-10-18-ci-linux-arm64/) and
[ci-darwin-arm64](../../bench/results/go-zig-adapter/2026-10-18-ci-darwin-arm64/).

Eight limits now pass and seven miss. Native Go's fuel and logical bytes match
Zig's on every Run, as before.

| Workload | Measure | Limit | Linux amd64 | Linux arm64 | macOS CI | Result |
|---|---|---|---|---|---|---|
| Warm execution | worst Run of core, collections, macro, excluding `fib@slice` | ≤ 2× | 1.78× | 1.41× | 0.98× | Pass |
| Restore | `lifecycle/restore` | ≤ 1.5× | 0.18× | 0.17× | 0.12× | Pass |
| Large Load | `lifecycle/load-large` | ≤ 2.5× | 2.02× | 1.43× | 1.11× | Pass |
| Load into a new Group | `Load/core/loop` | ≤ 3× | 2.58× | 4.33× | 1.98× | Miss |
| Group on shared code | `GroupInstantiation` | ≤ 10× | 6.1× | 9.2× | 14.4× | Miss |
| Cold start | first Group, warm `NORTHTALK_ZIG_CACHE_DIR` | ≤ 250 ms | 28 ms | 43 ms | 49 ms | Pass |
| Immediate Capability call | `BackendRequest`, `host/immediate`, `host/properties`, `host/pump` | ≤ 3× | 5.6–7.2× | 4.9–9.2× | 4.0–6.2× | Miss |
| Value conversion | `host/conversion` | ≤ 3× | 3.5× | 3.8× | 2.3× | Miss |
| Deferred call | `BackendDeferredCall/history=0` | ≤ 3× | 5.7× | 13.0× | 6.3× | Miss |
| Deferred call with age | Zig `history=5000` ÷ `history=0` | ≤ 1.2× | 1.00× | 1.00× | 1.03× | Pass |
| Rollback | `lifecycle/rollback` | ≤ 2× | 4.7× | 5.6× | 3.9× | Miss |
| Messaging | `messaging/*` | ≤ 2× | 1.8–2.4× | 1.5–2.4× | 1.3–2.1× | Miss |
| Multi-Group throughput | `BackendMultiGroup/groups=16` req/s | ≥ 0.5× | 0.37× | 0.30× | 0.69× | Miss |
| Tail latency | `BackendRequest` p99 | ≤ 3× | 2.1× | 2.8× | 2.7× | Pass |
| Retained memory | `BackendRetainedMemory` heap per Group | ≤ 4× | 1.7× | 1.7× | 1.7× | Pass |

The absolute figures on Linux amd64, native then Zig:

- Request round trip 5.9 µs / 34.5 µs, p99 35 µs / 75 µs, 89 / 266 allocations.
- Deferred call 15.8 µs / 90.6 µs, and 90.3 µs after 5000 earlier calls.
- 16 Groups 78.0k / 28.9k requests per second.
- Group instantiation 5.5 µs / 33.5 µs, with 6.3 KiB / 54.8 KiB allocated.
- Retained per Group 61 KiB / 104 KiB heap.
- Cold start: first Group 0.20 ms / 28 ms with a warm cache and 0.19 ms / 0.93 s
  without, a second Group on the same Core 25 µs / 550 µs.

Two Loads stand out on macOS only: `Load/host/properties` is 52× and allocates
2.4 MiB, and `Load/messaging/parents` is 25×. On Linux they are 6–12×. Linux
arm64 is the worst platform for every per-request row.

### Local reply-decoder profiling, 2026-10-18

Measured at `833bf55f`, after #1236 stopped retaining released Request results,
on Apple M5, darwin/arm64, Go 1.27.2, wazero v1.12.0, `CGO_ENABLED=0`, with a
warm compilation cache. This is local optimization evidence, not a new
three-platform acceptance run. The source change is in `impl/go/zig_backend.go`;
the decoder benchmark and lookup regression case are in `impl/go/zig_reply_test.go`.
Raw output, provenance, benchstat comparisons and profile summaries are in
[`2026-10-18-local-reply-decode-darwin-arm64`](../../bench/results/go-zig-adapter/2026-10-18-local-reply-decode-darwin-arm64/).

The request allocation profile puts 26% of sampled allocations in
`zigReply.entries`: temporary member slices and copied keys created while
decoding envelopes into Go structs. Struct decoding now caches its field keys
and fills raw-byte spans in one member pass, using a stack buffer for up to
16 fields and a heap fallback for larger structs. Embedded fields, escaped
keys, unknown members and first-member lookup semantics are preserved. Value
payloads still use the existing strict, iterative Value Encoding decoder.

Eight samples per configuration alternate before/after/native processes,
with fixed 2,000 iterations, separately at `GOMAXPROCS=3` and `10`:

- Request: 24.18 → 23.29 µs at 3 processors (−3.7%, p=0.005), and
  24.04 → 23.12 µs at 10 (−3.8%, p<0.001). Allocations fall from 266 to 190
  and bytes from 12.2 KB to 6.9 KB on both configurations.
- Deferred call, history=0: 55.90 → 54.42 µs at 3 processors (−2.6%, p<0.001).
  The 55.56 → 54.36 µs change at 10 is not significant (p=0.234).
  Allocations fall from 368 to 252 and bytes from 21.7 KB to 13.7 KB.
- 16-Group throughput: no significant change at either processor count.
  An earlier sequential run suggested a larger improvement; the alternating
  measurements did not reproduce it, so it is not claimed.
- A `RunStarted` Report decode, including ancestry and a numeric argument,
  falls from 65 to 35 allocations and 3,489 to 672 bytes. Its median time
  falls from 1.425 to 1.060 µs in five samples (p=0.008).

The follow-up request allocation profile no longer lists `zigReply.entries`
among its top allocation sites. Request serialization (`zigJSON`) and number
conversion remain visible. The initial CPU profile shows 31% of samples as
external code and 22% cumulatively under `zigDecodeResolving`; these samples
do not separate guest JSON from guest execution. The shipped artifact is
stripped, so this is not a guest-function profile.

A 2,000-call deferred trace records 28.55 ms of runnable-to-running delay
attributed to `zigGroup.callback`'s channel send, about 14.3 µs per iteration.
This measures scheduler delay in the answering-goroutine handoff, not CPU
time in the guest. It helps explain why decoder savings do not translate
directly into deferred-call latency savings.

The selected adapter acceptance suite passes with `CGO_ENABLED=0`, and again
with `-race`; the full untagged Go suite passes too. These include public
Report/Trace parity, persistence, Sessions, facilities and deep-reply tests.
No Spec, wire format or guest artifact changes are needed.

This does not complete #1103. Requests remain about 5.9–6.0× native and
deferred calls about 6.2–6.4× in these matched local runs, above the ≤3×
limits. Native Go remains outside the changed build-tagged code. The next
profiling work should distinguish guest parsing/serialization from execution,
and examine the deferred handoff; these measurements do not establish that
binary frames would meet the limits. Required-platform acceptance still needs
a fresh `go-zig-bench` run after the optimization lands.

Reproduce request CPU/allocation capture with:

```sh
CGO_ENABLED=0 go -C impl/go test -c -tags talk_zig_experimental -o /tmp/zig-profile.test
NORTHTALK_ZIG_CACHE_DIR=/tmp/zig-profile-cache /tmp/zig-profile.test \
  -test.run '^$' -test.bench '^BenchmarkBackendRequest$' \
  -test.benchtime 100000x -test.cpuprofile /tmp/request.cpu \
  -test.memprofile /tmp/request.mem
go tool pprof -top -alloc_objects /tmp/zig-profile.test /tmp/request.mem
```

Capture the deferred scheduler delay with the same binary:

```sh
NORTHTALK_ZIG_CACHE_DIR=/tmp/zig-profile-cache /tmp/zig-profile.test \
  -test.run '^$' -test.bench '^BenchmarkBackendDeferredCall/history=0$' \
  -test.benchtime 2000x -test.trace /tmp/deferred.trace
go tool trace -pprof=sched /tmp/deferred.trace > /tmp/deferred-sched.pb.gz
go tool pprof -top /tmp/zig-profile.test /tmp/deferred-sched.pb.gz
```

### Guest profiling and untraced Pumps, 2026-10-18

The next pass starts at #1239's merge, `f59c5d36`. A separate safe WASI build
with `-Dstrip=false` retains function names for wazero listeners. The opt-in
`TestGuestRequestProfile` harness in `impl/go/internal/zigwasm/guest_profile_test.go`
replays a Request and Pump with the adapter's negotiated features and a null
inline admission reply. It warms 1,000 requests, then measures 20,000, installing
a listener on one function family at a time. Three before/after samples alternate
between baseline and changed guests. These are inclusive timings, overlap at
nested calls, and include listener overhead; they are diagnostic evidence, not
an additive CPU breakdown. Optimizer-inlined functions may have no listener
calls: the unobserved `message.decodeValue` frame does not mean conversion is free.
The [Zig guide](../../impl/zig/README.md#building-and-testing) has reproduction commands.

Before → after median time per Request/Pump pair:

- JSON parsing: 2.86 → 2.81 µs, three calls (Request, Pump, inline reply).
- `Group.pumpWith`: 4.02 → 3.32 µs, one call, including inline polling.
- Report serialization (`writeHeld`): 0.891 → 0.890 µs.
- `Group.flush`: 0.455 → 0.085 µs across three calls.
- Reply completion (`finishOk`, including its flush): 0.297 → 0.129 µs.
- The two `sendExport` calls: 11.35 → 10.09 µs in total.

The avoidable work was in untraced Pumps: the Message Layer always installs a
Trace sink because Loads need its diagnostic records. It also formatted and
buffered Pump records, flushed them into the entry, then discarded them because
`entry.traced` was false. `runPump` now temporarily disables the machine writer
for untraced Pumps, restoring it on every return, including a paused crossing.
Load/change-code workers retain diagnostic collection; traced Pumps retain
their existing writer and crossing behavior. The regression test
`untraced Pump skips machine Trace formatting but keeps Reports` fails before
the change at 264 formatted bytes and passes after at zero with result 42.

The diagnostic after-build is from `174f0206`. The final production artifact
additionally limits writer restoration to untraced Groups, from source commit
`6974f1eb`, still safe and stripped, SHA-256
`0fbdeb4bb67ca70c444d944960356ef4c4efb0cc75b75276e9103ff289d67ea4`.
Both checked-in Go copies have identical bytes and provenance. The Elixir
release pin changes with a future reactor release, as before.

The public-API performance verdict uses the shipped artifacts, not the
instrumented diagnostic builds: Apple M5, Go 1.27.2, wazero v1.12.0,
`CGO_ENABLED=0`, warm compilation cache, fixed 2,000 iterations and eight
alternating native/before/after samples at each processor count:

- Request: 22.62 → 21.57 µs at `GOMAXPROCS=3` (−4.6%, p<0.001), and
  22.77 → 21.58 µs at `10` (−5.2%, p<0.001).
- Deferred call, history=0: 59.64 → 57.64 µs at `3` (−3.4%, p=0.021), and
  59.40 → 57.80 µs at `10` (−2.7%, p<0.001). No history-related growth is observed.
- 16-Group throughput rises 5.6% at `3` (p<0.001) and 4.4% at `10` (p=0.007).
  There is no Go-side allocation reduction: the removed allocations were in
  the guest, outside Go's benchmark allocation counters.

Raw results, profile output, artifact hashes and comparisons are in
[`2026-10-18-local-untraced-pump-darwin-arm64`](../../bench/results/go-zig-adapter/2026-10-18-local-untraced-pump-darwin-arm64/).
Zig unit/C checks, both WASI checks, all ten native sidecar protocol tests,
and the selected Go adapter acceptance suite pass; the adapter suite also
passes with `-race`. The ordinary test suite skips the opt-in profiler.

This is another partial #1103 improvement. Requests remain 5.8× native and
deferred calls 6.6–6.9× in this local run; this is not required-platform
acceptance. Parsing is still a material guest cost, but removing all of its
measured 2.8 µs would not bring a 21 µs public request down to the roughly
11 µs allowed by native's 3.7–3.8 µs result. The remaining Go-side and guest
costs still need attention before a wire-format or retirement decision.

### Host callback profiling and envelope scans, 2026-10-18

Measured against `63675505`, after #1273, on Apple M5, Go 1.27.2 and wazero
v1.12.0, with `CGO_ENABLED=0`, the default fields exchange and a warm compilation
cache. The guest artifact is unchanged, source `870efbff`, SHA-256
`9c8d0925b5e063e4aa0a62c7566a6b9e721aba13f3b697e71a8735325032f1b4`.
Raw native/before/after output, paired reports, benchstat comparisons, profile
summaries and reproduction scripts are in
[`2026-10-18-local-host-callback-darwin-arm64`](../../bench/results/go-zig-adapter/2026-10-18-local-host-callback-darwin-arm64/).

The initial four-round baseline reproduced the misses: immediate callbacks
6.04× native, properties 4.70×, conversion 3.30× and deferred calls 3.41×.
The short deferred samples ranged from 1.95× to 3.71×, so the final experiment
uses longer samples. These are local diagnostic measurements, not the
required-platform acceptance for #1103.

In the immediate workload, repeated `zigReply.get` calls account for 19% of
sampled CPU, and `zigSkip` alone for 11.5%. Each Operation need was walked again
for every Call field. Reading all its raw spans in one pass removes that repeated
work. Property callbacks now read their envelope once too, instead of allocating
and copying a temporary member list to distinguish getters from setters. Explicit
null still denotes a setter; duplicate members retain first-member semantics.
Value Encoding validation, callbacks and their admission/Trace ordering are
unchanged. No Message Layer or guest change is needed.

The final comparison rotates native, unchanged adapter and changed adapter
processes through eight rounds at each of `GOMAXPROCS=3` and `10`. Each Host
sample has 100 Runs (500 crossings per Run except the empty `host/pump` Handler);
Backend samples have 10,000 iterations. Reported paired ratios are medians of
per-round mean operation times, not latency percentiles. Benchstat comparisons
remain alongside them:

- Immediate callbacks: 4.467 → 3.964 ms at 3 processors (−11.3%, p=0.010),
  and 4.686 → 4.122 ms at 10 (−12.0%, p<0.001). Paired reductions are 10.9%
  and 12.1%. Allocation is unchanged.
- Property callbacks: 2.490 → 2.421 ms (−2.7%, p=0.005), and
  2.618 → 2.512 ms (−4.0%, p<0.001). Each Run saves 152,000 bytes (20.5%)
  and 2,500 allocations (11.1%): 304 bytes and five allocations per crossing.
- Conversion: 8.325 → 7.728 ms (−7.2%, p<0.001), and
  8.608 → 7.901 ms (−8.2%, p<0.001), without changing its actual Value codec.
- Sixteen-Group throughput: +2.8% at 3 processors (p<0.001), and +4.2% at
  10 (p=0.001); paired improvements are 2.6% and 3.4%.
- Deferred calls: no significant change at 3 processors (p=0.328); −3.5%
  at 10 is borderline (p=0.050). There is no claim of a reliable deferred win.
- Empty Pump shows no significant change at either processor count. The
  unchanged Request control, collected at 10 processors, remains 8.70 µs
  (p=0.574). Native uses the same unmodified binary throughout.

The after-profile reduces `zigReply.get` below the top 25 sampled nodes;
`zigSkip` falls to 3.9%. External/compiled guest code remains prominent (57%),
but ordinary Go pprof does not identify guest functions, so it does not establish
which guest activity to optimize next. Percentages from different captures are
diagnostic, not an additive wall-time breakdown.

Deferred scheduler traces at 20,000 iterations attribute 162.7 ms (8.1 µs per
iteration) of runnable-to-running delay to the channel send under the adapter's
callback. The matched native trace has 54.8 ms (2.7 µs per iteration). These are
instrumented scheduling delays, not CPU costs or guaranteed removable latency.
The immediate trace does not show a comparable callback handoff cost: ordinary
paused Operation needs run directly in the exchange loop. Skipping or moving a
callback goroutine is therefore not supported as a general fix by these profiles.

Reproduce from the repository root, after its setup checks:

```sh
results=bench/results/go-zig-adapter/2026-10-18-local-host-callback-darwin-arm64
python3 "$results/build.py" /tmp/callback-binaries
python3 "$results/measure.py" /tmp/callback-p3 --bin-dir /tmp/callback-binaries --procs 3
python3 "$results/measure.py" /tmp/callback-p10 --bin-dir /tmp/callback-binaries --procs 10
```

The build script overlays only the two changed implementation files from the
recorded baseline; it leaves the checkout intact. Original 3-processor results
predate addition of the Request control to the runner. For CPU/allocation
profiles use the `before-host.test` or `after-host.test` binary with
`-test.run='^$' -test.bench='^BenchmarkRun$/^host$/^immediate$'`
and `-test.benchtime=1000x -test.cpuprofile=FILE -test.memprofile=FILE`.
For scheduler traces use the corresponding Backend binary with
`-test.bench='^BenchmarkBackendDeferredCall$/^history=0$'`, 20,000 iterations
and `-test.trace=FILE`; inspect it with `go tool trace -pprof=sched`.

The native Go suite, adapter acceptance in JSON/map/fields modes and fields
acceptance with the race detector pass. Added callback-envelope cases check
Host context, Fuel refusal, escaped/duplicate keys and null setter dispatch.
Native full Corpus also passes. An additional full Corpus run through the
adapter reproduces two unchanged-baseline failures: the missing Group seed
([#1285](https://github.com/odogono/odgn-talk/issues/1285)) and a 64 MiB inspection
frame panic in `limits/persistent-state-minimum`
([#1286](https://github.com/odogono/odgn-talk/issues/1286)). Full adapter Corpus
acceptance remains #1055; the selected acceptance suite is the check passed here.
This remains partial #1103 work: paired local ratios are about 5.5× for
immediate callbacks, 4.5× for properties, 3.0× for conversion and 3.5–3.7×
for deferred calls. Further work should separate guest callback
parsing/serialization from execution, and investigate the deferred settlement
handoff independently. Required-platform acceptance still needs fresh CI evidence.

### Settlements carried by the Pump (#1320), 2026-10-19

With `settlements-fields-v1`, `Call.Answer` and `Call.Fail` queue their
settlement, as native Go queues its input, and the next binary Pump carries
the queue in a `settle-pump` frame
([spec](../../spec/embedding/request-pump-binary.md#settlements-carried-by-a-pump)).
Any other input first sends the queue as ordinary `answer`/`fail` inputs, so
the guest's input order stays the Host's. A deferred call now makes four
guest exports, all binary: `request`, `settle-pump` (→ `op` need),
`op-result`, `settle-pump` carrying the answer. The JSON `answer` export is
gone. `TestZigBackendDeferredAnswerRidesThePump` checks the frames sent.

Interleaved local A/B on an Apple M5, 20,000 iterations, five rounds, p50 µs
(main 4c84ef53 / this change):

| Benchmark | main | this change |
| --- | --- | --- |
| `BackendDeferredCall/history=0` | 29.04–29.50 | 24.21–25.00 |
| `BackendDeferredCall/history=5000` | 29.04–29.71 | 24.17–24.83 |
| `BackendRequest` | 8.33–8.71 | 8.33–8.58 |

That is about 17% off a deferred call, close to the 4 µs export the issue
estimated, with no change to Requests. Allocations are unchanged (144 per
call).

### Deferred-call acceptance after #1325 and #1326, 2026-10-19

Both parts have merged: [#1325](https://github.com/odogono/odgn-talk/pull/1325)
releases retired Calls after the Message Layer writes their notices and folds
finished Runs' issued-call ranges into spans; [#1326](https://github.com/odogono/odgn-talk/pull/1326)
queues settlements with the next Pump. Late answers still use the issued-call
history, and the save format is unchanged. The embedded reactor was rebuilt
with `build-artifact.py` after those changes; the current artifact records
source `7baedc84c0ff2be21480ee7da8920db1b6c2f2f8` and SHA-256
`28bd5f868aee52fb6dff325faeb7cec4d2b9dd5ee57c0dbc26894cdbea7bca0e`.

The completed [go-zig-bench run 39255311353](https://github.com/odogono/odgn-talk/actions/runs/39255311353)
measured the settle-pump change at `741fd953`, using artifact `c6de4844…`.
Its full-suite results are archived under
[`1320-settle-pump`](../../bench/results/go-zig-adapter/1320-settle-pump/).
Compared with [run 39250561088](https://github.com/odogono/odgn-talk/actions/runs/39250561088)
([raw baseline](../../bench/results/go-zig-adapter/2026-10-19-ci-after-1311-run2/)),
`BackendDeferredCall/history=0` improved on all three platforms. Medians of
five samples, before / after:

| Platform | Zig mean (µs) | Zig p50 (µs) | Native mean (µs) |
| --- | ---: | ---: | ---: |
| Linux amd64 | 104.23 / 36.66 | 99.07 / 29.96 | 26.06 / 15.20 |
| Linux arm64 | 161.04 / 138.64 | 154.81 / 128.67 | 23.24 / 24.46 |
| macOS arm64 | 93.17 / 67.38 | 61.88 / 47.00 | 20.64 / 24.59 |

These are separate CI jobs, not interleaved A/B. The large amd64 native
change shows substantial runner variation, so the absolute reduction there
cannot be attributed wholly to this change. The controlled local A/B above
establishes about a 17% p50 reduction. These results satisfy #1320's
improvement check; they do not establish #1103's remaining limits or prove
that native timing is unchanged across jobs.

`TestZigBackendDeferredCallsRetainNothing` now warms up for 2,000 calls, then
checks unchanged guest linear-memory size every 20,000 calls through 200,000
calls, and checks that the adapter retains no Call records. It runs in the
ordinary `CGO_ENABLED=0 impl/go/zig-experimental-check.sh` gate, alongside
`TestZigBackendDeferredAnswerRidesThePump`'s four-binary-frame assertion.
The extended regression also reproduces the original bug against the pre-fix
`f8644caf` artifact in an isolated Go-module copy: the first 20,000-call batch
grows guest memory from 3,211,264 to 14,417,920 bytes. The full gate passes
on the current artifact. Both tests also pass under `-race`: guest memory
stays at 2,228,224 bytes throughout the 200,000 calls. Rebuilding the current Core
with `build-artifact.py` reproduces the same embedded bytes.

Elixir pins [reactor-v0.9.0](https://github.com/odogono/odgn-talk/releases/tag/reactor-v0.9.0)
at that digest, incorporating both fixes. Its save format remains `zig/13`.
The package's 102 tests pass on this reactor.

## Cancellation before subsequent callbacks, 2026-10-15

After #971 merged as `e9b8aa57`, its [embedded probe CI](https://github.com/odogono/odgn-talk/actions/runs/38716047470)
confirmed pure-Go tests/vet/race and separate cross-builds on all four targets.
The public-adapter audit then combined two previously separate behaviors: Call
context cancellation and another Script's effect cleanup. Native Go cancels
pending work before the cleanup callback. The Message Layer reached Rollback
without notifying its Host until the final Pump reply. The red probe reproduced
the same omission before Operation, property and Grant release callbacks.

[#972](https://github.com/odogono/odgn-talk/issues/972) carries the additive
[early-abandonment contract](../../spec/embedding/paused-crossing-inputs.md#abandonment-before-a-subsequent-callback)
and Zig implementation. Hosts opt in with `hello.features` and check support
for `abandoned-before-needs-v1`; existing Hosts retain final-success-reply timing.
Opted-in Hosts receive notices before servicing the next need, including Grant
release before a held reply, and on final worker errors. A serialized notice is
consumed once, with no early Reports/Trace or extra worker execution.

An outbox cannot fix this observation by waiting for the final reply; cancelling
when Stop is admitted acts before the input lands. Direct WASM callback imports
or cgo would introduce another backend and ownership model. An opt-in Message
Layer notice closes this gap within the agreed backend, preserving existing
Hosts. The correction precedes public adapter expansion; no Go backend selection,
production API replacement, or retirement is included.

Runtime source `05f2a66d0216626908a3b32c0b70a945add010d6` passes 270 Zig tests plus
C Host checks, both 429-case ordinary/deferred Corpus replays, native sidecar and
WASI checks, and the rebuilt embedded parity suite with pure-Go tests/vet/race.
Current artifact execution is local Darwin/arm64; all four targets cross-compile
without cgo and the existing CI matrix executes the new artifact separately.
No expectation files change. [Current raw measurements](../../spikes/go-zig-binding/measurements-abandonment.txt)
give median immediate-call run averages of 3.754 µs native / 31.650 µs probe
(8.4×), cold compile/runtime/close 614.8 ms and cached instantiation/close 123.7 µs.
The matched benchmark remains an immediate-call workload without the feature
opt-in, not cancellation latency or performance acceptance.

## Callback compatibility probe, 2026-10-15

The follow-up starts from #967's merged main (`dcd733c3`) and rebuilds the
artifact from runtime source `5ae0965a`. Its focused native-Go/embedded-Zig suite
passes panic conversion in all three Operation modes, property callbacks and
Stop-before-conversion, suspended Call context cancellation, Function identity
and Group ownership, Object identity/disposal, staged effect rollback/scope
abandonment/Grant release, pending-call Answer/Fail/Adopt/Reissue and worker
reentry. The [probe guide](../../spikes/go-zig-binding/README.md) defines the
comparison fields and the Host adapter's remaining ownership responsibilities.
This is executable feasibility evidence, not a public-compatible binding.

The new tests found three Zig discrepancies and track their corrections in
[#968](https://github.com/odogono/odgn-talk/issues/968) (property failure Reports
and failed-setter Trace), [#969](https://github.com/odogono/odgn-talk/issues/969)
(callback worker-refusal Trace) and
[#970](https://github.com/odogono/odgn-talk/issues/970) (deferred reissued Start).
No corpus expectations changed. The corrected source passes 269 Zig tests, the C
Host check, both ordinary and deferred 429-case corpus replays, native sidecar
checks and the embedded pure-Go probe. Its embedded-probe CI
passes execution/vet/race and separate cgo-free cross-builds on Linux/macOS
amd64/arm64. That evidence belongs to #971's artifact; the early-abandonment
artifact needs its own matrix results.

[Refreshed measurements](../../spikes/go-zig-binding/measurements-callbacks.txt)
for that source give median immediate-call run averages of 3.733 µs native Go
and 31.510 µs embedded probe (8.4×), cold compile/runtime/close 641.7 ms and
cached-code instantiate/close 119.0 µs on the same Apple M5/Go 1.27.2 setup.
These do not establish a numerical acceptance limit, latency percentiles,
application throughput or retained memory. Historical measurements below remain
attached to their original artifact.

Remaining work is a public-compatible Go adapter and complete embedding/Corpus
acceptance, facilities and Pool integration, broader error/metering/lifecycle
coverage, all-platform execution and agreed workload/performance limits. The Go
Core remains supported; no retirement ADR or public API replacement is included.

## Crossing implementation, 2026-10-15

The maintainer accepted merged design #958 for implementation. Runtime source
commit `ae39dc59` implements paused-input admission in Zig and the supported Go
sidecar messages, retains starting Calls and callback returns, and pauses release
continuations before further execution. Native Zig corrections are tracked in
[#962](https://github.com/odogono/odgn-talk/issues/962).

The rebuilt embedded artifact's [manifest](../../spikes/go-zig-binding/artifact.json)
names its source revision and digest. `TestStopAtCrossingParity` now compares
native Go with that artifact for immediate valid/wrong-Shape returns, Host/Script
failures and suspending Start, requiring identical Trace and Fuel and `n=0`.
This replaces the old blocker characterization; the original results below
remain historical evidence, not claims about the updated implementation.

Later #884 gates remain: the full callback compatibility matrix, production
binding/API/corpus acceptance, Go facilities, all-platform execution and explicitly
accepted numerical performance limits. No production binding or retirement is
introduced by resolving the original Stop gate. The historical measurements below describe their original artifact; the callback
follow-up above records a separate current run.

## Follow-up design, 2026-10-15

The investigation merged in [#921](https://github.com/odogono/odgn-talk/pull/921)
as `c49f544c`. The separate reactor switch merged in
[#918](https://github.com/odogono/odgn-talk/pull/918) as `667458bc`.
Against `0aed90d300069ae754ba7dab010f3ef4d92141e7`, the
[paused-crossing audit](paused-crossing-input-audit.md) confirmed that the transport
gate remained blocked at that revision and identifies starting-Call identity and result-landing
requirements beyond opening the dispatcher.

The [crossing contract](../../spec/embedding/paused-crossing-inputs.md)
specifies admission, ordering, lifecycle boundaries and parity acceptance. The proposal
subsequently merged as #958 and was accepted for implementation. Its handoff
records the current base and remaining gates. No production binding or retirement
is authorized by this design.

Zig Metered Operations, including `request-charge`, have since landed in
[#920](https://github.com/odogono/odgn-talk/pull/920) as `f6477343`; the statement
below about their absence describes the original investigation revision. Native
Go still lacks that API in this follow-up checkout. The probe artifact and its
measurements below remain evidence for their recorded source revision.

## Agreed direction

Reducing maintenance of independent language implementations is the objective.
Go remains a supported Host language. A Go binding is an adapter to the Zig
Core, not another independently implemented Core.

Evaluate wazero over the Message Layer first. Ship a version-matched embedded
artifact so Go consumers need neither Zig, cgo nor a runtime download. Preserve
the public Go API, garbage-collected values without per-value Release, and all
existing facilities: Pool, Store, sqlite, Session Host/REPL, native sidecar and
the unchanged tenants example. Go value utilities and Host helpers may remain;
a permanent Go parser/checker/compiler/interpreter would undermine the objective.
Session language analysis must eventually move to Zig, preserving diagnostics,
inspection, descriptions and Fix/Continue.

The experimental binding now uses Zig analysis for the Go Session Host and REPL.
The [Go guide](../../impl/go/README.md#experimental-zig-backend) describes current
support, the native build choice and the remaining Session runtime gaps.

Linux and macOS, each on amd64 and arm64, require execution verification as well
as cross-compilation. Existing Go-Core saves are disposable for this cutover;
document a fresh start, not a cross-Core converter. The replacement must still
support Zig save/restore. TS–Zig parity remains required.

Numerical performance limits are deliberately **not yet agreed**. Measure matched
workloads, then obtain explicit acceptance of limits and evidence before
retirement. The separate Message Layer reactor switch in
[#918](https://github.com/odogono/odgn-talk/issues/918) does not authorize retiring
the Go Core. ADRs 0009 and 0078 remain in effect until a later accepted retirement
ADR supersedes their conflicting portions; ADR 0008's same-Core saves remain.

## First gate: Stop inside a Host callback

The probe uses the same Script on native Go and Zig:

```text
script variable n = 0
on go
 put 9 into n
 ask api to read
 put 8 into n
 return n
end go
```

The native Go `read` callback calls `Stop("crossing")`, then returns `7`. The
Pump returns stopped and `n` is `0`. This agrees with the existing Go
`TestStopAtCapabilityCrossingRollsBackAndSkipsConversion` test and the
[interruption rules](../../spec/06-errors-and-limits.md#cancellation-and-stop).

At the original probe's Zig Message Layer `op` need, `stop` was rejected with
`protocol error: a Pump is waiting for its result`. Returning `op-result` first
lets the Run complete with `8`. Sending Stop afterward leaves `n=8`. A wrapper
cannot claim compatibility by deferring all callback-generated inputs until the
Pump returns. This is a limitation of the present Message Layer path, not proof
that native Zig Stop semantics are wrong or that wazero cannot support a binding.

At the investigation revision, the relevant dispatcher was
`impl/zig/src/message.zig`'s `handle`: while
`paused_ref` is set, only the matching `op-result`, `prop-result` or
`effect-result` is accepted. The Go Message Layer similarly rejected intervening
messages. At that point, the Spec's “answer before sending anything else” and “Stops land at a
crossing” rules needed an explicit compatible transport mechanism before the
Message Layer can serve as a transparent public Go API adapter.

## Alternatives to evaluate next

1. **Extend the Message Layer at paused crossings (recommended).** Specify which
   queued Host Inputs may arrive before the matching result, their ordering,
   admission errors and callback-return landing semantics. Preserve result
   validation, lifecycle acknowledgements and cancellation cleanup ordering.
   Add parity cases for Stop, cancellation, Rewind and owner disposal from
   Operation/property callbacks, including lifecycle exchanges. Resolve the Spec
   wording and implement the agreed behavior in both reactors as applicable.
2. **Direct WASM ABI with Go callback imports.** This remains pure Go but needs
   a Zig trampoline/import bridge, explicit memory/handle ownership, and safe
   reentry. Current `talk.h` function pointers do not automatically call Go;
   the built reactor imports only WASI. Measure and prototype before choosing it.
3. **cgo as an additional backend.** Consider only for a demonstrated requirement.
   It does not satisfy mandatory pure-Go support alone and introduces another
   binding plus native ownership and synchronization work.

Do not select the direct ABI or cgo merely from this first result. The agreed
failure gate requires reporting and evaluating alternatives before expanding
implementation scope. Smaller Fuel slices and translating Stop into a Script
error are not equivalent: they change scheduling or termination semantics.

## Corrections to the original issue

- The old #635 blocker list is obsolete. Zig now transports restore/settle,
  resolve, functions/call, effects/releases and Standard Capabilities except
  sqlite. `request-charge` remains absent across Cores (#911).
- `tools/zig/api.ts` checks declaration names, not signature or behavioral parity.
  The native binding is not established as “needs nothing more from Zig”.
- Native asynchronous answers and native value releases require serialization;
  Zig's value refcounts and input append path do not provide that automatically.
  No thread-local declaration was found under `impl/zig`, which is not itself a
  complete thread-affinity audit.
- JSON overhead belongs to the Message Layer, not all WASM embedding paths.
- `max_pending_ms` and Go `MaxPending` already have a specified whole-millisecond
  conversion; choosing a new unit is unnecessary.
- The sqlite module no longer supplies a wazero precedent: its current
  dependencies are go-sqlite3 and go-sqlite3-wasm/v6. Wazero is independently
  pinned to v1.12.0 in the isolated probe. Its
  [runtime API](https://github.com/tetratelabs/wazero/blob/v1.12.0/runtime.go)
  supports sharing compiled code across independently instantiated modules.
- Pool and sqlite mostly use the public API. Store and Session have internal
  dependencies and need separate migration work.

## Evidence and remaining gates

The [probe guide](../../spikes/go-zig-binding/README.md) records tests, platform
coverage, limitations and preliminary benchmark interpretation; its
[raw measurements](../../spikes/go-zig-binding/measurements.txt) are retained.
The immediate-call probe is about 8× native Go in this one workload. No numerical
threshold has been approved, and this unoptimized comparison cannot settle the
backend choice. Cold compilation, cached-code instantiation and initial linear
memory were measured separately; neither application tail latency nor retained
process memory was measured. The
[2026-10-17 measurements](#adapter-measurements-against-native-go-2026-10-17)
now cover both through the public adapter.

The focused callback probe above covers the next gate after Stop. Broaden its
error/metering/lifecycle coverage and test Pool concurrency in the public adapter.
Build the public-compatible adapter, run existing embedding tests and the full
Conformance Corpus through it, migrate the Go facilities, and measure the
existing benchmark suite plus deferred calls and multi-Group workloads.
Compare startup/load/restore, warm execution, value conversion, throughput,
tail latency and retained memory on matched builds before setting retirement
limits. Cross-compilation alone must never mark execution coverage complete.

The first experimental public-interface slice now lives behind
`talk_zig_experimental`; see the [Go guide](../../impl/go/README.md#experimental-zig-backend)
for its supported operations and limitations. It uses Go-owned data Values and
one guest per Group with GC cleanup, while the separate probe continues to
compare native Go against the Message Layer. The public adapter uncovered the
ordinary Zig Pump Clock divergence tracked in #976, now checked in the shared
machine before draining inputs. Full API/Corpus, facilities, concurrent-input
admission, non-observational Trace sinks and performance remain gates.

The Message Layer definition now includes language-specific embedding adapters,
with Appendix A regenerated. Native Go remains the default Core; no retirement
ADR or production cutover is part of this experimental slice.

## Large-state transport acceptance (#1286)

On 2026-10-19, `chunked-wasi-v1` removes the large inspection failure without
raising the 64 MiB transfer bound. The Go adapter negotiates it on shared and
restored guests. Input assembly dispatches only the final chunk; output windows
and inline continuation headers carry complete logical messages up to 2 GiB
minus one byte. The [transport contract](../../spec/embedding/chunked-wasi.md)
records bounds, ownership and failure behavior. The implementation source is the
commit recorded by the refreshed [guest manifest](../../impl/go/internal/zigwasm/artifact.json).

The root cause was the valid retained Text of 67,108,848 bytes: Inspect emits a
`vars` Trace record whose JSON envelope exceeds 64 MiB before it returns the
inspection reply. Removing that failure also exposes a large Save and its
Base64 Restore input, so chunking covers both export directions and both inline
directions. No reviewed expectation changed. The selected adapter gate now
runs `TestLimitsStepFourAcceptance/limits/persistent-state-minimum`, including
hidden Save/Restore replay. Transport regressions additionally cover large
inputs, UTF-8 splits, final-chunk observation, malformed complete messages and
response framing.

Memory was measured with Go 1.27.2, Zig 0.17.0, `CGO_ENABLED=0`, darwin/arm64,
using compiled Corpus binaries rather than including the compiler in the peak:

```sh
CGO_ENABLED=0 go -C impl/go build -o /tmp/corpus-native ./cmd/corpus
CGO_ENABLED=0 go -C impl/go build -tags talk_zig_experimental -o /tmp/corpus-zig ./cmd/corpus
/usr/bin/time -l /tmp/corpus-native limits/persistent-state-minimum
/usr/bin/time -l /tmp/corpus-zig limits/persistent-state-minimum
```

Native Go passes at 676,888,576 bytes maximum resident set size (646 MiB).
Untouched `fc005bca` panics at the inline frame guard, at 3,688,841,216 bytes
(3.44 GiB). The completed chunked replay passes at 5,669,699,584 bytes (5.28 GiB)
maximum resident set size; macOS also reports 7,108,630,264 bytes (6.62 GiB)
peak memory footprint. These are individual local observations, not portable
ceilings or a performance acceptance. Chunking bounds transfers, not total
memory: the guest still retains Script state and builds Trace/JSON/Save data,
both endpoints assemble whole messages, and wazero retains grown linear memory.
This makes the complete valid replay possible but does not establish that such
Groups are economical. Streaming serialization/decoding would be separate work.

The full native Corpus passes all 446 cases. The full adapter run completes
with 444 passing cases and two unchanged-baseline failures:
[`builtins/random` (#1285)](https://github.com/odogono/odgn-talk/issues/1285) and
[`save-restore/variables-only-restore` (#1304)](https://github.com/odogono/odgn-talk/issues/1304).
The latter was separately reproduced from a clean `git archive fc005bca impl/go`
build. It is resolved in the follow-up below. Full Corpus acceptance remains blocked in
[#1055](https://github.com/odogono/odgn-talk/issues/1055); fixing this transport
does not approve Go Core retirement or satisfy #1103's performance limits.

### Library replacement restore follow-up (#1304, 2026-10-19)

The mismatch came from the Go adapter's replay bridge, which did not retain
Libraries after AddLibrary or ReplaceLibrary. The Corpus's replacement step
therefore obtained no current handles from `replay.Libraries` and kept offering
the original `fmt` to Restore. Zig correctly performed a full restore against
that matching identity; neither its Library lookup nor its mismatch policy was
at fault.

The adapter now retains registered handles and updates them after successful
replacement, recompiling handles for transitive dependants through Zig as well.
It records only source imports as dependencies, so an unused offered Library
cannot introduce a false dependency. Refused replacements retain the old set.
`TestLibraryReplayAfterReplacement` exercises this replay-to-Restore seam on
native Go and the adapter, including matching full restore, rejected
replacement, RejectMismatch and VariablesOnly. The unchanged
`save-restore/variables-only-restore` case passes through both backends.

With this follow-up rebased on the #1285 fix, the full native and adapter
Corpus runs each pass 446/446 on Go 1.27.2, `CGO_ENABLED=0`, darwin/arm64. No
expectations changed. This is Corpus evidence for #1055, not retirement or
performance acceptance.
