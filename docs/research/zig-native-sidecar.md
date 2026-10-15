# Native Zig sidecar cutover verification

Evidence for [#965](https://github.com/odogono/odgn-talk/issues/965), collected
2026-10-15 from the uncommitted `fix/issue-965` worktree based on `9db1b5d4`.
This records local execution, separately from cross-compilation and future CI.
The replacement decision is [ADR 0090](../adr/0090-the-native-message-layer-sidecar-uses-zig.md).
The public Go Core remains; [#884](https://github.com/odogono/odgn-talk/issues/884)'s
broader compatibility, platform and performance gates remain open.

## Implementation and coverage

[`src/sidecar.zig`](../../impl/zig/src/sidecar.zig) contains only framed process
I/O and owns one `message.Session`. All dispatch, paused Host Inputs, Value
Encoding and save/restore use the existing Zig implementation. Every target
uses the safe build policy. The Linux artifacts are static executables; macOS
uses its system `libSystem`. Neither needs Go nor a WASI runtime.

The Go command and the private `internal/messagelayer` package had no remaining
consumer after the switch and are removed. The public Go API, shared Value
code, callback hooks and facilities are retained; `go test ./...` passes.
Existing Zig Message Layer tests cover the retired adapter's dispatch behavior,
including Libraries, Object routing, releases and Reload/replacement.

The [10 executable tests](../../tools/sidecar/check.py) verify:

- Multiple, fragmented and pipelined frames; replies flushed while stdin stays
  open; numeric and encoded integer refs; clean EOF and stdout ownership.
- Malformed JSON/UTF-8 and 100,000-level arrays/maps, including deep error data;
  20,000-level Values through traced Requests, Operation needs and replies.
- Exact 64 MiB admission, oversized-frame draining and same-Session recovery,
  truncated headers/bodies and oversized-body truncation with stderr diagnostics.
- Immediate and suspended Operations, Answer and RequestCharge during Start,
  wrong refs and malformed frames during a paused exchange, worker reentry,
  property Stop before conversion, cancellation and Rewind rollback.
- Segment begin/commit/rollback, automatic scope cleanup, Grant release
  acknowledgement, and restoring a pending call in a fresh executable process.

`zig build test --summary all` passes **267 tests** plus the C Host executable.
`zig build corpus` and `zig build corpus -- --defer-crossings` each pass all
**429 cases**. Both WASI checks (`tools/wasi/check.py` and `tools/wasi/zig.py`)
pass against the rebuilt reactor. No Spec, Data File or corpus expectations
changed; no first blessing is needed.

## Platform evidence

Zig **0.17.0**, safe/stripped builds; local host Apple M5, macOS 27.0.1 arm64.
Artifact sizes, hashes, runtime source hashes and detailed memory results are in
[the raw record](../../tools/sidecar/results/2026-10-15-native.json).

| Target | Build | Execution |
| --- | --- | --- |
| macOS arm64 | native and explicit `aarch64-macos` target pass | 10 executable tests pass on the local M5 |
| macOS amd64 | `x86_64-macos` cross-build passes | **Unverified**: this host returns `OSError: [Errno 86] Bad CPU type in executable` |
| Linux arm64 | `aarch64-linux-musl` cross-build passes | 10 tests pass in Docker Desktop's arm64 Linux VM; process memory and cgroup checks pass |
| Linux amd64 | `x86_64-linux-musl` cross-build passes | 10 tests pass under explicit `qemu-x86_64` in an arm64 Linux container; native amd64 hardware remains unverified |

Docker's default amd64 translator failed before the sidecar's `main` with
`rosetta error: bss_size overflow`. Explicit QEMU user emulation passes the same
binary. This is emulated execution evidence, not execution on amd64 hardware.
The [arm64](../../tools/sidecar/results/2026-10-15-linux-arm64.txt) and
[amd64](../../tools/sidecar/results/2026-10-15-linux-amd64.txt) test logs are retained.

CI now has separate target cross-builds and execution jobs on macOS/Linux,
amd64/arm64, using the [published runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Those jobs are configured, **not yet run for this worktree**. macOS amd64
execution remains an unchecked #965 criterion. A cross-build is not a runtime
verification result.

## Memory, containment and smoke measurements

`uv run tools/wasi/list_memory.py --sidecar <binary>` passes all eight
default/conformance-minimum, local/persistent, text/Nothing cases on macOS arm64
and Linux arm64. Every case reaches its expected Limit Fault, rolls back and
runs a healthy Handler on the same Session. The OS-reported process peak stays
within the existing backstop for every case; this change adds no memory or
performance limit. Raw per-case numbers are in the record above.

Elixir **1.20.4**, OTP **29**, Wasmex **0.15.1**: `mix test` passes all three
round-trip tests. `TalkHost.Artifacts.build!()` builds the reactor, native
sidecar and Linux sidecar with Zig only. The Port asserts `hello.core` is Zig.
Reports identify the native artifact by SHA-256 and preserve Go metadata when
rendering historical reports.

Docker **29.8.0**, cgroup v2, Linux arm64: `Containment.sidecar(3)` passes both
profiles, with and without caps (128 MiB default, 1 GiB minimum), across growing
Lists, doubling text and growing Script Variables. Three repetitions per
case end in the expected allocation or Persistent State fault and retain a
healthy Session. Every cgroup records **zero OOM/OOM-kill events**. The raw
record includes peaks/events and the existing containment verdicts. Docker was
available; no containment result is being inferred from an uncapped process.

The [Elixir sidecar smoke report](../../bench/results/2026-10-15-9db1b5d4-zig-native-sidecar-smoke.md)
uses `mix talk.measure --quick --transports sidecar --no-save`: 500 latency
samples after warm-up, 30 instantiations, three memory instances, three fault
repetitions and 100 mutated sources. Its fault and malformed-input cases lose
no instance, and every health check passes. These small-sample timings check
the harness; they establish no new performance gate or full Go retirement
verdict. Existing historical Go reports remain unchanged.

## Reproduction and remaining verification

Build and executable commands are in the [Zig guide](../../impl/zig/README.md#native-message-layer-sidecar).
For Linux arm64, mount this checkout read-only at `/w` in a `python:3.13-alpine`
arm64 container and run `python /w/tools/sidecar/check.py
/w/.cache/zig-linux-arm64/bin/messagelayer`. For amd64 under QEMU, use an arm64
Debian container with `qemu-user` and Python installed; pass the tests a launcher
that executes `qemu-x86_64 /w/.cache/zig-linux-amd64/bin/messagelayer`. Linux
process-memory checks use `python:3.13-slim` with the script's pinned dependencies.

From `bench/message-layer/elixir`, build with
`mix run -e 'TalkHost.Artifacts.build!()'`, run `mix test`, and run the smoke
command above. Direct cgroup verification uses `TalkHost.Containment.sidecar(3)`
and `TalkHost.Report.verdicts` on its results, as the CI job does.

Before marking the issue complete, obtain macOS amd64 execution evidence and
run the configured CI matrix. Native Linux amd64 execution remains stronger
evidence than the local QEMU result. Merge/publication is still pending.
The Go-Core-save cutover starts fresh Groups from source and Host-owned data;
there is no cross-Core save converter. The executable test restores Zig's own
pending-call save in a new Zig process. No full Go Core retirement is approved.
