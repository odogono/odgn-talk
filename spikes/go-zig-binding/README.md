# Go → Zig Message Layer feasibility probe

Experimental evidence for [#884](https://github.com/odogono/odgn-talk/issues/884),
not a replacement Go embedding package. The Go Core remains in place.

## Result

**The original Stop crossing gate now passes.** A Go Operation queues Stop before
returning through the Message Layer, and the same Pump rolls its Segment back.
`TestStopAtCrossingParity` compares native Go and the embedded Zig artifact for
immediate returns, wrong Shapes, Script failures, Host errors and suspending
Start. It requires identical Trace lines and Fuel and checks `n=0` on both paths.
The previous characterization of native `n=0` versus transport `n=8` is replaced.

This remains an isolated probe, not a public Go binding. Full callback/API/corpus
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
- Basic Zig save/restore; no cross-Core save conversion.
- Independent concurrent reactors sharing compiled code, serialized export calls,
  and Go-owned reply bytes retained across guest memory growth.

`Reactor.Frame` serializes buffer allocation, writing, export calls and copying.
It does **not** make concurrent, interleaved need/result conversations valid.
Each complete conversation needs one owner. Closing an Engine requires its
reactors to have finished. The probe's JSON decoder also retains Go's nesting
limit; it is not sufficient for the Message Layer's unlimited nesting contract.

No claim is made yet about callback panic conversion, cancellation contexts,
property callbacks, Function Value identity, effect hooks, full public API or
corpus compatibility, driver Pool integration, or Session facilities. Those remain
retirement requirements beyond the original Stop gate.

## Historical measurements

The measurements below used the original investigation artifact from
`34c990976c5b863b7791bc64c8ac760c263e2e9d`, not the rebuilt crossing implementation.
They have not been rerun and must not be attributed to the new artifact.

[Raw output](measurements.txt) records three repetitions on Darwin/arm64,
Apple M5, Go 1.27.2, wazero v1.12.0, Zig 0.17.0, safe optimization, with
`CGO_ENABLED=0`. The artifact's source commit is in [its manifest](artifact.json).
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

All four agreed targets cross-compile without cgo. Execution and race checks
were performed only on Darwin/arm64. Linux amd64/arm64 and Darwin/amd64 execution,
application workloads, tail latency and retained memory remain unverified.
