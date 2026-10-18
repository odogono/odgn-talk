# Binary Request and Pump experiment: implementation status

Work for [#1245](https://github.com/odogono/odgn-talk/issues/1245), under
[proposed ADR 0110](../adr/0110-request-and-pump-have-an-optional-binary-exchange.md).
This is a partial implementation record, not performance acceptance or evidence
that the target cannot be met. ADR 0098 remains accepted.

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

The native helpers remain private until the performance gate permits the public
Host declarations to land together. Publishing only the proposed Go declarations
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

## Remaining implementation

Steps 1–3 below are done in #1253, as described above.

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
