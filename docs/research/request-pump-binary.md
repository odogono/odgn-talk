# Binary Request and Pump experiment: implementation status

Work for [#1245](https://github.com/odogono/odgn-talk/issues/1245), under
[ADR 0110](../adr/0110-request-and-pump-have-an-optional-binary-exchange.md),
which supersedes ADR 0098. It records the implementation and the measurements
behind the gate decision.

## Implemented foundation

- Private native Go combined admission/Pump helpers claim one worker guard,
  preserve input ordering, retain the admitted Pending on Pump refusal, and
  notify OnReady only after releasing the worker on that refusal. Function
  staleness remains a drain-time failure. An unsupported backend refuses before
  admission.
- Direct Go and Zig Value codecs cover every Value kind through Object and
  Function resolvers, including negotiated Function metadata and Core-error
  markers. Both use heap work stacks and preserve canonical decimal scale.
- The proposed frame document specifies both candidate envelopes, Report field
  layouts, mixed JSON continuations, correlation and cancellation, and the
  browser transport boundary.
- The native combined Request and Function benchmarks are separate from the
  unchanged public `BackendRequest` benchmark.

The native helpers stayed private until the gate decision, so the public Host
declarations land together. Publishing only the proposed Go declarations
would immediately violate the repository's required Go/C API comparison. The
comparison remains unchanged; no missing C implementation is hidden by a stub
or an exception.

## Integrated transport (#1253)

- The Zig Session offers both candidates at `hello`, refuses both together, and
  fixes the chosen one for the Session. It decodes `request`, `call`, `pump`,
  `request-pump` and `call-pump` straight into typed inputs and Values, and
  writes admission and final Pump replies, every Report included, without
  JSON. The JSON and binary admissions share one implementation.
- A binary exchange keeps its layout across JSON needs, Trace pauses and Grant
  releases, per Group. Its final reply then carries the abandonment notices.
  Malformed envelopes are JSON protocol errors and change nothing.
- Combined inputs are refused as competing workers before admission while a
  worker is open. They admit once, bind their token before anything runs, and
  Pump once. An unusable Clock or Fuel option refuses the Pump after admission.
  `cancel-correlated` is `cancel-delivery` by token. The final reply retires
  the token.
- The Go adapter negotiates the candidate named by `TALK_ZIG_REQUEST_PUMP`
  (`map` or `fields`). Ordinary Requests, Function calls and Pumps then use
  binary frames, and the private `requestPump`/`callPump` helpers use the
  combined messages after the ordinary Go-side admission checks. The Host
  registers each combined Pending before sending it. A cancellation queued
  before the token retires is rewritten to the delivery id at transmission.
- Inline admission remains JSON: a queued ordinary binary input crosses in its
  JSON form, and a binary worker input waits for the export boundary.

The whole `zig-experimental-check.sh` selection, Sessions, Corpus parity,
driver, Store, tenants and sqlite included, passes with `CGO_ENABLED=0` in
JSON, map and fields modes. CI now runs it in both binary modes too.

### Local integration smoke measurements

[Raw output and environment](../../bench/results/go-zig-adapter/1253-integration-smoke/)
record five 2,000-iteration samples per backend on Apple M5, darwin/arm64,
with a hand-built Zig artifact. Medians, in ns/op:

| Workload | Native | Zig JSON | Zig map | Zig fields |
| --- | ---: | ---: | ---: | ---: |
| `BackendRequest` (unchanged) | 3,272 | 20,442 | 15,141 | 12,520 |
| Combined Request | 5,002 | – | 13,732 | 11,359 |
| Combined Function call | 3,297 | – | 18,252 | 15,759 |

These are not gate evidence. Only one platform ran, with no unchanged-base
regression comparison and no controlled ordering. Locally, the combined Request is
under 3× native and the unchanged Request is not. A combined Function call
spends most of its extra time building and reading the opaque Function token.
#1254 measures all three platforms and makes the agreed optimization pass.

## Local native smoke measurements

[Raw output](../../bench/results/go-zig-adapter/1245-native-foundation/native.txt)
and [environment](../../bench/results/go-zig-adapter/1245-native-foundation/env.txt)
record five 2,000-iteration samples on Apple M5, darwin/arm64. Medians:

| Native workload | ns/op |
| --- | ---: |
| Existing Request plus Pump | 3,406 |
| Combined Request/Pump helper | 4,952 |
| Combined Function-call/Pump helper | 3,273 |

These are smoke measurements from an uncommitted worktree. There is no matching
Zig binary run, unchanged-base regression comparison, Linux run, or candidate
layout comparison. Benchmark order and local noise have not been controlled;
do not infer an API speedup or regression from this table. Neither performance
gate has been evaluated, and the targeted optimization pass has not occurred.

Reproduce from the repository root after its setup checks:

```sh
go -C impl/go test -run '^$' -bench '^BenchmarkBackend(Request|RequestPump|CallPump)$' -benchmem -benchtime=2000x -count=5 .
```

## Validation

The native Go package, Value tests and API comparison pass, including race
checking. The experimental Zig adapter test confirms unsupported combined calls
consume no delivery id. The full Zig build passed 348 tests before adding the
allocation-failure codec case; the focused codec suite additionally exercises
that case. Both codecs exercise 20,000 nested Lists, canonical integer boundaries,
scaled zero, malformed and truncated input, duplicate keys and NFC refusal.
A five-second Go decoder fuzz run completed 1,356,781 executions without failure.
Spec generation, repository checks, formatting and documentation links pass.

## Gate measurements (#1254)

`impl/go/zig-request-pump-bench.sh`, run by the `go-zig-bench` workflow,
measures five backends in one job. It runs native `BackendRequest` at
`ff543e29`, the commit before the experiment. It also runs native, Zig JSON,
Zig map and Zig fields at the head. Each is ten interleaved rounds of 2,000
iterations. Medians in µs/op, with Zig as a multiple of native in the same job:

| Run | Platform | Native Request | Fields Request | Map Request | Native combined | Fields combined | Map combined |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [Baseline](../../bench/results/go-zig-adapter/1254-baseline/) | macOS arm64 | 8.25 | 31.0 (3.76×) | 39.6 (4.80×) | 8.01 | 29.0 (3.62×) | 35.3 (4.42×) |
| | Linux arm64 | 10.09 | 50.1 (4.97×) | 56.4 (5.59×) | 10.42 | 49.1 (4.71×) | 54.7 (5.25×) |
| | Linux amd64 | 9.66 | 35.6 (3.69×) | 41.7 (4.32×) | 10.25 | 31.4 (3.06×) | 37.3 (3.64×) |
| [Optimized](../../bench/results/go-zig-adapter/1254-optimized/) | macOS arm64 | 8.00 | 28.2 (3.53×) | 32.7 (4.09×) | 7.75 | 27.5 (3.55×) | 29.8 (3.85×) |
| | Linux arm64 | 10.01 | 45.6 (4.55×) | 52.4 (5.23×) | 10.38 | 41.7 (4.02×) | 47.2 (4.54×) |
| | Linux amd64 | 11.72 | 71.3 (6.09×) | 78.1 (6.67×) | 12.09 | 63.8 (5.28×) | 70.5 (5.83×) |

Native shows no regression against the base on any platform; the largest
significant change is −7.65%. The optimized amd64 job's runner was slower
throughout: its JSON Request took 98 µs against 55 µs in the baseline. Read
ratios within each job.

**Neither gate passes on any platform, with either envelope.** Fields beats map
by 10–19% on the unchanged Request in every job.

The targeted pass followed a profile of the fields Request round trip. It
decodes the four Reports every Request produces without reflection, and reads
integer Values without a decimal parse. It gained 6–13% on the Zig arm64 jobs.
Idle inline polls were profiled too; answering them without parsing made no
measurable difference, so that change was dropped.

**Bottleneck.** On Apple M5, a fields Request round trip took 11.8 µs. Guest
frames took 8.3 µs of it: the wazero call and Zig execution under
`-Doptimize=safe`. The Host-side remainder, about 3.4 µs, is about what native
Go takes for the whole round trip. A transport-only pass can't reach the
limit. Getting under 3× needs cheaper guest execution, or a cheaper wazero call
and memory crossing, per Request. Either is outside this envelope experiment.

Under the original rule, that stopped broader implementation for maintainer
review.

**Gate decision.** The maintainer amended the gate (#1245). The exchange is
accepted when it beats JSON by at least 25% in the same job on every platform
for both Request benchmarks, with no native regression. Fields passes in both
runs on every platform.

| Run | Platform | JSON Request | Fields Request | Fields combined |
| --- | --- | ---: | ---: | ---: |
| Baseline | macOS arm64 | 46.0 | 31.0 (−33%) | 29.0 (−37%) |
| | Linux arm64 | 73.6 | 50.1 (−32%) | 49.1 (−33%) |
| | Linux amd64 | 54.7 | 35.6 (−35%) | 31.4 (−43%) |
| Optimized | macOS arm64 | 48.0 | 28.2 (−41%) | 27.5 (−43%) |
| | Linux arm64 | 72.3 | 45.6 (−37%) | 41.7 (−42%) |
| | Linux amd64 | 98.0 | 71.3 (−27%) | 63.8 (−35%) |

The combined Request is compared with JSON's separate Request and Pump, which
does the same work. Fields is selected, and ADR 0110 is accepted, superseding
ADR 0098. #1255–#1257 proceed. The ≤3×-native target is now a guest-cost goal
tracked in #1267.

## Remaining implementation

Steps 1–3 below are done in #1253. Step 4 is measured above, and failed; step 5 is blocked.

1. Integrate both binary frame candidates into the Go adapter and Zig Session,
   using typed Values and Reports rather than JSON transcoding. Preserve binary
   reply mode across JSON needs and per-Group parked exchanges.
2. Implement combined guest admission/Pump and exchange-scoped token cancellation,
   including Host provisional Pending registration and late-cancellation rewrite.
3. Exercise every Report, callback/Trace ordering, abandoned/settled/gone handling,
   malformed-frame recovery and cancellation races through the actual transport.
4. Run the existing and combined Request gates on all three platforms, record
   Function measurements, profile, and perform the agreed one optimization pass
   if needed. Select the envelope by the ADR's rule.
5. Only after passage, publish and implement the Go, TS, Elixir and C APIs;
   verify transferred-buffer browser interoperability and Elixir handle lifetime.
6. Accept/supersede the ADRs only with the required evidence. Keep #1245 and
   #1103 open meanwhile.
