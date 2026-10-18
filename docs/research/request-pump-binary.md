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
