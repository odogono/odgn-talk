# Go → Zig Message Layer feasibility probe

Experimental evidence for [#884](https://github.com/odogono/odgn-talk/issues/884),
not a replacement Go embedding package. The Go Core remains in place.

## Result

**The focused callback compatibility gate passes on all four targets in #971.** A Go Operation queues Stop before
returning through the Message Layer, and the same Pump rolls its Segment back.
`TestStopAtCrossingParity` compares native Go and the embedded Zig artifact for
immediate returns, wrong Shapes, Script failures, Host errors and suspending
Start. It requires identical Trace lines and Fuel and checks `n=0` on both paths.
The previous characterization of native `n=0` versus transport `n=8` is replaced.

The follow-up callback suite also compares panic conversion, properties, work
context cancellation, Function and Object ownership, effect cleanup, restored
Calls and worker reentry. It found and corrected Zig discrepancies tracked in
[#968](https://github.com/odogono/odgn-talk/issues/968),
[#969](https://github.com/odogono/odgn-talk/issues/969) and
[#970](https://github.com/odogono/odgn-talk/issues/970).

A subsequent combined cancellation/cleanup test found a timing gap tracked in
[#972](https://github.com/odogono/odgn-talk/issues/972): final-reply-only
`abandoned` arrives after a later callback can observe its context. The current
artifact adds opt-in `abandoned-before-needs-v1` timing. The new tests check
cancellation before Operation, property, Rollback and Grant release callbacks,
fatal worker errors and exactly-once notices. Existing Hosts keep final-reply
timing; request the feature in `hello` and check support before relying on it.

This remains an isolated probe. The [experimental public Go adapter](../../impl/go/README.md#experimental-zig-backend)
covers data/Request, ordinary Broadcasts, ordinary Capability Operations and
Stop/Revoke Grant release hooks behind
`talk_zig_experimental`. Its public Host tests independently compare Trace, Fuel
and typed Reports against a separately built native-Go test binary. Full API/corpus
compatibility, facilities, platform execution and agreed performance limits are
later gates in [#884](https://github.com/odogono/odgn-talk/issues/884). See the
[findings](../../docs/research/go-zig-binding.md) and the
[crossing contract](../../spec/embedding/paused-crossing-inputs.md).

## Run

From the repository root, with Go 1.27:

```sh
CGO_ENABLED=0 go -C spikes/go-zig-binding test -v ./...
go -C spikes/go-zig-binding test -race ./...
CGO_ENABLED=0 go -C spikes/go-zig-binding test -run '^$' -bench . -benchmem -benchtime=300ms -count=3
```

The normal tests need no Zig installation or runtime download. The checked-in
`talk.wasm` is embedded with `go:embed`; Go fetches the pinned module dependencies
normally. `artifact.json` records its SHA-256, source commit, Zig version and build
flags. `TestArtifact` verifies its digest and language, Cost Model and Unicode
versions against the checked-out native Go baseline. Race testing itself uses
cgo, as required by Go's race detector; the binding path does not.

To rebuild the artifact as a maintainer, install this repository's Zig version
and prepare generated data as the [Zig guide](../../impl/zig/README.md) describes,
then run:

```sh
python3 spikes/go-zig-binding/build-artifact.py
```

The builder refuses uncommitted Core/spec changes rather than attaching false
commit provenance. Changes to the binary require rerunning the probe and
measurements. The same command refreshes the identical artifact and manifest in
`impl/go/internal/zigwasm`. This probe remains an independent module and native-Go
comparison baseline; the opt-in public adapter has its own pinned dependency.

## What it checks

- WASI initialization, version matching, and embedded artifact integrity.
- Immediate and genuinely deferred answers from another Go goroutine.
- Same-callback Stop parity against native Go, including exact Trace, Fuel and rollback.
- Operation panic conversion in immediate, suspending and fire-and-forget modes;
  getter/setter success, wrong Shape and panic, including Stop before conversion.
- Suspended Call work contexts cancelled on CancelRun, Stop, timeout and Request
  context cancellation; exactly one abandonment and harmless late answers.
- Captured Function round trips/calls, nested foreign-Group rejection and stale
  Functions after Reload; Object identity, duplicate ids and owner disposal.
- Staged Host effects commit normally or roll back on Stop, with automatic scope
  abandonment and Grant release in order, without repeat cleanup.
- Zig save/restore with Answer, Fail, Adopt and Reissue settlements; reissued Start
  preserves its Call id and can Stop before returning. No cross-Core save conversion.
- Worker reentry (Pump, Save, Load, Inspect, Counters and code/Library changes),
  refusal Trace ordering, malformed/wrong-ref/wrong-Group recovery, independent Sessions.
- Independent concurrent reactors sharing compiled code, serialized export calls,
  and Go-owned reply bytes retained across guest memory growth.

`Reactor.Frame` serializes buffer allocation, writing, export calls and copying.
It does **not** make concurrent, interleaved need/result conversations valid.
Each complete conversation needs one owner. Closing an Engine requires its
reactors to have finished. The probe's JSON decoder also retains Go's nesting
limit; it is not sufficient for the Message Layer's unlimited nesting contract.

The adapters in `compatibility_test.go` and `abandonment_test.go` execute real Go callbacks outside the
export lock, recover panic into `hostError`, and map `abandoned` notifications to
Host work-context cancellation. These responsibilities are demonstrated in tests;
`Reactor` itself supplies only bytes and export serialization. Report comparisons
select identities/order, outcomes, accounting, error codes and cleanup status;
Trace comparisons are exact. Non-normative error wording and Host-only detail
are excluded. The suite is a focused parity gate, not all public embedding tests.

Object wire values contain kind/id, not a Group owner. A public Go adapter must
validate Object handles recursively before encoding; equal kind/id in another
Group cannot establish shared ownership. Function tokens carry a Group identity
and the protocol rejects foreign tokens. Public handle ownership, callback
registration/lifetimes, all error and metering paths, GC ergonomics, Pool
integration, the full API/Corpus and Session facilities remain binding work.

The [probe CI](../../.github/workflows/go-zig-probe.yml) executes pure-Go tests,
vet and race checks on Linux amd64/arm64 and macOS arm64, separately from
cross-compilation. These three targets form the current CI matrix.
[#971's embedded run](https://github.com/odogono/odgn-talk/actions/runs/38716047470)
passes all four native execution/race jobs as well as cross-builds for its
recorded artifact. Current early-abandonment artifact execution is verified
locally on Darwin/arm64; its own matrix must pass before extending that claim.
A passing sidecar matrix does not prove embedded-wazero execution.

## Host Object artifact refresh, 2026-10-16

[Raw output](measurements-objects.txt) records three repetitions with artifact
source `6edafcc6`, SHA-256
`9080c2370e22e2fe5a3a2a6929e78f97a45ff9c58b32893819386b05b3924aec`,
and public-adapter/native-Go revision `7b2841da`.
On Darwin/arm64 Apple M5, Go 1.27.2, wazero 1.12.0 and `CGO_ENABLED=0`, median
immediate-call run averages are **3.983 µs native Go vs 33.410 µs probe (8.4×)**,
cold compile/runtime/close **639.3 ms**, cached instantiation/close **132.5 µs**.
This is the same independent immediate-call workload; it does not measure
public Object or property latency, tail latency or an accepted retirement limit.

The public comparison now covers 103 callback/input scenarios. Seventeen new
Host Object scenarios compare exact Trace, Fuel, typed Reports, futures and
inspected state against a separately compiled native-Go Host: Message Path
routing and climbing, unowned targets, object Decisions, handles as values,
properties with costs, failures, panics and callback-generated inputs, owner
disposal, parent and foreign refusals, Object Shapes, full climbs, receiving
limits, owner refusals, stopped receivers and Kinds first used in callbacks.
Forty-one existing native Object, property and Message Path tests join the
experimental selection. Zig corrections are tracked in #1021, the opt-in
`climb-v1` Message Layer field in #1022, and a native Go/talk.ts difference
in #1023. Both artifacts are refreshed together.

Native Go, adapter/probe pure-Go/race/vet, Zig unit/C tests, all 430 ordinary
and deferred Corpus cases and both WASI checks pass locally. Independent pure-Go
adapter/probe cross-builds cover Linux amd64/arm64 and macOS arm64. This
revision still needs CI execution on the other required runners.

## Decision artifact refresh, 2026-10-16

[Raw output](measurements-decide.txt) records three repetitions with artifact
source `e22f3e1d0de291adbe7eb6722af463e88842cd08`, SHA-256
`361f71cd1f4e556304a083aba04e8e455cb7da5532c0069bbec45c17ab05e2cf`,
and public-adapter/native-Go revision `57049bc7`.
On Darwin/arm64 Apple M5, Go 1.27.2, wazero 1.12.0 and `CGO_ENABLED=0`, median
immediate-call run averages are **3.736 µs native Go vs 31.648 µs probe (8.5×)**,
cold compile/runtime/close **619.0 ms**, cached instantiation/close **122.0 µs**.
This is the same independent immediate-call workload; it does not measure
public Decision latency, tail latency or an accepted retirement limit.

The public comparison now covers 86 callback/input scenarios. Twenty-seven new
Decision scenarios compare exact Trace, Fuel, typed Reports, settled futures
and inspected state against a separately compiled native-Go Host. They cover
vetoes with Value reasons, every undecided outcome, ordinary-clause and
first-wait seals, dropping/replacing, Stop, cancellation in the mailbox,
preempted and after the seal (including from a later crossing in the sealing
Pump), Broadcast Decisions across slices and with no recipients, Broadcast
cancellation that spares sealed recipients, refusals including Deliver/Request
overrides, and Operation/release/Trace/OnReady-generated Decisions. Shared Zig
corrections are tracked in #1014 and #1015. Both artifacts are refreshed
together.

Native Go, adapter/probe pure-Go/race/vet, Zig unit/C tests, all 430 ordinary
and deferred Corpus cases and both WASI checks pass locally. Independent pure-Go
adapter/probe cross-builds cover Linux amd64/arm64 and macOS arm64. This
revision still needs CI execution on the other required runners.

## Ordinary Broadcast artifact refresh, 2026-10-15

[Raw output](measurements-broadcast.txt) records three repetitions with artifact
source `2afaddd76d6cf1794b1271d1f034b53fff5bc805`, SHA-256
`044b1a5b789c60db5cefa59608abb16eb96967fdd53be1a9a7ba84fc67c25c84`,
and public-adapter/native-Go revision `7772853e`.
On Darwin/arm64 Apple M5, Go 1.27.2, wazero 1.12.0 and `CGO_ENABLED=0`, median
immediate-call run averages are **3.716 µs native Go vs 31.810 µs probe (8.6×)**,
cold compile/runtime/close **616.6 ms**, cached instantiation/close **125.8 µs**.
This is the same independent immediate-call workload; it does not measure
public Broadcast latency, tail latency or an accepted retirement limit.

The public comparison now covers 59 callback/input scenarios. Fourteen new
Broadcast scenarios compare exact Trace, Fuel, typed Reports and inspected
state against a separately compiled native-Go Host. They cover drain-time
selection, prior Stop/cancelled waits, nested input copies, explicit zero and
tighter recipient limits, refusals, and Operation/release/Trace/OnReady-generated
Broadcasts. Shared Zig corrections are tracked in #987; native Go’s wait-override
Trace key correction is tracked in #988. Both artifacts are refreshed together.

Native Go, adapter/probe pure-Go/race/vet, Zig unit/C tests, all 429 ordinary and
deferred Corpus cases, TS Corpus and both WASI checks pass locally. Independent
pure-Go adapter/probe cross-builds cover Linux amd64/arm64 and macOS arm64.
This revision still needs CI execution on the other required runners; ordinary
Broadcast support does not establish Decision-future or full API compatibility.

## Fire/Grant release artifact refresh, 2026-10-15

[Raw output](measurements-fire-release.txt) records three repetitions with
artifact source/public-adapter revision `43859e23e07ea78102500762a481b10fef975252`,
SHA-256 `42077d940f70226b844fa6f62577d96c8151dc9dde9e4b26a68e75322e238f7d`.
On Darwin/arm64 Apple M5, Go 1.27.2, wazero 1.12.0 and `CGO_ENABLED=0`, median
immediate-call run averages are **3.807 µs native Go vs 31.040 µs probe (8.2×)**,
cold compile/runtime/close **607.5 ms**, cached instantiation/close **122.1 µs**.
This refresh measures the same independent immediate-call probe; it does not
measure public Fire/release performance, tail latency or an accepted limit.

The public suite compares 45 callback scenarios with a separately compiled
native-Go Host, including Fire costs/failures/Stop and Grant release ordering,
cancellation, panic swallowing, trimming, concurrent queued Requests and OnReady
reentry. Exact Trace, Fuel and typed Reports match. The unchanged public
Load/cache checks also catch the empty-Grant correction tracked in #984;
C API regressions cover direct Capability calls and imported Library needs.
Public adapter/probe pure-Go, race and vet checks pass locally, along with
native Go, Zig unit/C tests, ordinary/deferred Corpus and WASI checks. Separate
pure-Go cross-builds cover Linux amd64/arm64 and macOS arm64. Execution on the
other required runners was accepted in merged PR #985 with all 36 checks
passing, including adapter/probe tests/vet/race and separate cross-builds.

## Public Capability artifact refresh, 2026-10-15

[Raw output](measurements-public-callbacks.txt) records three repetitions with
artifact source `bba90b5036893b3b4b042483908812d07c565fba`, SHA-256
`067857e5b1404ee31566a6440823963c1652c3120cde2f3235bebe05af2ec157`, and
public-adapter/native-Go revision `bba90b50`. On Darwin/arm64 Apple M5, Go 1.27.2,
wazero 1.12.0 and `CGO_ENABLED=0`, median immediate-call run averages are
**3.808 µs native Go vs 32.975 µs probe (8.7×)**, cold compile/runtime/close
**628.3 ms**, and cached instantiation/close **123.0 µs**. This remains the
independent probe's workload, with no `crossing-trace-v1` opt-in; it does not
measure the public adapter, tail latency or an accepted performance limit.
Earlier measurement files retain their own artifact provenance.

The refreshed artifact passes the independent probe and public-adapter
pure-Go/race/vet checks locally on Darwin/arm64. Separate pure-Go cross-builds
cover Linux amd64/arm64 and macOS arm64. PR #982 merged with all 36 checks passing, including adapter/probe execution
and separate cross-builds on all three required platforms. The older merged
runs below establish execution only for their named revisions.

## Public-slice artifact refresh, 2026-10-15

[Raw output](measurements-public-slice.txt) reruns the same probe benchmarks
against source `0dd032fd1c62397e9adaeb3914be724956ba4198`, SHA-256
`196ef79a1aa9c32724e32db526f54d22f29b94a3e85612368f94d574308c922f`,
including the ordinary Pump Clock correction. On Darwin/arm64 Apple M5, Go 1.27.2,
wazero v1.12.0, Zig 0.17.0 safe, three-run median averages are **4.145 µs native
Go vs 34.338 µs probe (8.3×)**, **633.3 ms** cold setup/compile/close and
**126.7 µs** cached instantiation/close. These measure the independent callback
probe, not the experimental public adapter or application tail latency. No
performance limit or retirement verdict follows from this refresh.

## Early-abandonment artifact measurements, 2026-10-15

[Raw output](measurements-abandonment.txt) records three repetitions on the same
Darwin/arm64 Apple M5, Go 1.27.2, wazero v1.12.0 and Zig 0.17.0 safe setup,
with `CGO_ENABLED=0`. Artifact source `05f2a66d0216626908a3b32c0b70a945add010d6`,
SHA-256 `25a91a9369784186e305d2681f4f584cf41edf7701721f83ea1161792abab9fd`, **2,984,484 bytes**.
Median immediate-call run averages: native Go **3.754 µs**, embedded probe
**31.650 µs** (**8.4×**); cold runtime/compile/close **614.8 ms**, cached-code
instantiate/close **123.7 µs**. The immediate-call benchmark uses the existing
Host conversation without early-abandonment opt-in; it refreshes the same matched
workload for this binary, rather than measuring cancellation latency. No latency
percentiles, retained-memory or performance-acceptance claim follows from it.
Earlier measurement files remain tied to their named artifacts.

## Callback-gate measurements, 2026-10-15

[Raw output](measurements-callbacks.txt) records three repetitions using source
`5ae0965a6c6a3503aac6c5742e3313d7477c9d94`, SHA-256
`f725e3ecf740c104f501b2a785e011c49519fc1b2f503397a51f7022d0fc93a6`,
Go 1.27.2, wazero v1.12.0, Zig 0.17.0 safe, Darwin/arm64 Apple M5 and
`CGO_ENABLED=0`. Median run averages: native Go **3.733 µs**, embedded probe
**31.510 µs** (**8.4×**); cold runtime/compile/close **641.7 ms**, cached-code
instantiate/close **119.0 µs**. These are the same unoptimized end-to-end workload
and measurement boundaries described below, not isolated crossing cost or
latency percentiles. No numerical performance limit is accepted. Application
workloads, deferred-call performance, tail latency and retained memory remain
unmeasured for this artifact.

## Historical measurements

The measurements below used the original investigation artifact from
`34c990976c5b863b7791bc64c8ac760c263e2e9d`, not the rebuilt crossing implementation.
They have not been rerun and must not be attributed to the new artifact.

[Raw output](measurements.txt) records three repetitions on Darwin/arm64,
Apple M5, Go 1.27.2, wazero v1.12.0, Zig 0.17.0, safe optimization, with
`CGO_ENABLED=0`. The historical artifact source is the revision named above; the current artifact
has separate provenance in [its manifest](artifact.json).
Compilation and loading are outside the immediate-call timing. Both paths request
and pump the same Script and verify `42`; native Go uses its public API while
the probe includes map-based JSON encoding, decoding, Reports and test helpers.
This is an unoptimized end-to-end probe comparison, not isolated crossing cost.

Median of three run averages: native Go 3.900 µs, probe 31.234 µs (8.0×), cold
compile/runtime setup and teardown 623.1 ms, cached-code instantiation and close
124.0 µs. These are **not latency percentiles**. Go allocation bytes exclude
guest allocations as independent events and are not retained-memory measurements.
The binary is 2,999,778 bytes; initial guest linear memory after hello is
1,835,008 bytes, excluding compiled code and Go runtime overhead.

The historical run cross-compiled all four targets and executed only on
Darwin/arm64. See current evidence above for the callback artifact.
