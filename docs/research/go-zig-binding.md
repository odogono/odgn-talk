# Replacing the Go Core: first binding investigation

Evidence recorded on 2026-10-14 for [#884](https://github.com/odogono/odgn-talk/issues/884),
against `34c990976c5b863b7791bc64c8ac760c263e2e9d`. The
[reproducible probe](../../spikes/go-zig-binding/README.md) embeds a Zig WASI
reactor and executes it through wazero. **The original investigation failed its first compatibility gate;
follow-up Stop parity is described below. The Go Core remains supported.**

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
