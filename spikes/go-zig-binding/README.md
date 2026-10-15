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

This remains an isolated probe, not a public Go binding. Full API/corpus
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
measurements. This isolated module does not add dependencies to the Go Core.

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
vet and race checks on Linux/macOS amd64/arm64, separately from cross-compilation.
[#971's embedded run](https://github.com/odogono/odgn-talk/actions/runs/38716047470)
passes all four native execution/race jobs as well as cross-builds for its
recorded artifact. Current early-abandonment artifact execution is verified
locally on Darwin/arm64; its own matrix must pass before extending that claim.
A passing sidecar matrix does not prove embedded-wazero execution.

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
