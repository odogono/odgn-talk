# Replacing the Go Core: first binding investigation

Evidence recorded on 2026-10-14 for [#884](https://github.com/odogono/odgn-talk/issues/884),
against `34c990976c5b863b7791bc64c8ac760c263e2e9d`. The
[reproducible probe](../../spikes/go-zig-binding/README.md) embeds a Zig WASI
reactor and executes it through wazero. **The original investigation failed its first compatibility gate;
follow-up Stop parity is described below. The Go Core remains supported.**

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
process memory was measured.

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
