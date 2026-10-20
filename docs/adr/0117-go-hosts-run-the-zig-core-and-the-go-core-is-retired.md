---
status: accepted
---

# Go Hosts run the Zig Core, and the Go Core is retired

For [#1055](https://github.com/odogono/odgn-talk/issues/1055), part of [#884](https://github.com/odogono/odgn-talk/issues/884), the Go embedding API runs the Zig Core through an embedded `wasm32-wasi` reactor under wazero, over the Message Layer, and the Go parser, checker, compiler and interpreter are removed. Three independent language implementations cost every Spec change and parity fix three times (ADR 0078). The Go adapter now passes the full Conformance Corpus, and the maintainer accepted its performance on 2026-10-20 ([#1103](https://github.com/odogono/odgn-talk/issues/1103)). We keep the TS Core for the browser and Bun, and the Zig Core for every other Host.

## Considered Options

- **Keep three Cores:** keeps native Go speed and no WASM boundary, but every language change still lands three times, which is what ADR 0078 accepted reluctantly.
- **cgo against `talk.h`:** faster crossings, but it breaks pure-Go builds (`CGO_ENABLED=0`), which Go Hosts require. It stays possible only as an optional backend for a demonstrated need.
- **Direct WASM exports instead of the Message Layer:** only for a demonstrated Message Layer shortcoming. The binary envelopes (ADR 0110) closed most of the measured gap without them.
- **Drop the TS Core instead:** the browser would pay a JS↔WASM crossing on every event and Capability call (ADR 0009's reason, unchanged).

## Consequences

- **Supersedes in part [ADR 0009](0009-twin-cores-held-to-bit-for-bit-parity.md):** the twin Cores are now TS and Zig. Bit-for-bit parity, the Conformance Corpus as the only authority, and shared data rather than shared logic are unchanged. Go–TS parity checks become TS–Zig parity checks.
- **Supersedes in part [ADR 0078](0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md):** the Zig Core is no longer a third Core. Its cost of every change landing three times ends.
- **Preserves [ADR 0008](0008-same-core-save-restore.md):** saves stay same-Core. Existing Go-Core saves can't be restored. Go Hosts drain them on the old runtime or start fresh, with no cross-Core converter. Zig saves through the binding are the Go Host's saves from now on.
- **The Go API stays:** the public Go embedding API, garbage-collected Values without a per-value `Release`, and the Go value utilities and Host helpers remain. Pool, Store, sqlite, the Session Host and REPL, and the tenants example keep working. Session language analysis moves to the Zig Core.
- **Deployment:** Go Hosts build with `CGO_ENABLED=0` and need only Go. The version-matched reactor is embedded, not downloaded. Linux amd64/arm64 and macOS arm64 are required platforms.
- **Accepted performance:** the Go API is slower than native Go was. The accepted scorecard and the gaps not pursued (deferred calls, AMD EPYC 7763 runners) are recorded on #1103 and [#1377](https://github.com/odogono/odgn-talk/issues/1377).
- **Public tests:** native Go tests that read Go Core internals are removed with the Go Core. Tests that assert Go behaviour the Zig Core and TS don't share are changed to the Zig behaviour ([#1037](https://github.com/odogono/odgn-talk/issues/1037)). Behaviour differences the public suite found were fixed in the Zig Core before removal ([#1400](https://github.com/odogono/odgn-talk/issues/1400)–[#1403](https://github.com/odogono/odgn-talk/issues/1403), [#1068](https://github.com/odogono/odgn-talk/issues/1068), [#1428](https://github.com/odogono/odgn-talk/issues/1428)). The capability parity test keeps the native Go Core's recorded observations as its reference.
- **Accepted adapter cost:** guest memory is Go heap, so load-time memory through the adapter is bounded at 40× the source for blank lines and 320× for Handler-heavy source ([#1403](https://github.com/odogono/odgn-talk/issues/1403)); the checker's per-Handler cost is [#1411](https://github.com/odogono/odgn-talk/issues/1411).
- **Carried out** in [#1416](https://github.com/odogono/odgn-talk/pull/1416), [#1426](https://github.com/odogono/odgn-talk/pull/1426), [#1433](https://github.com/odogono/odgn-talk/pull/1433) and [#1436](https://github.com/odogono/odgn-talk/pull/1436). The Go module keeps a lexer and parser only for Host-side name validation and Text Pattern sizing, until [#1435](https://github.com/odogono/odgn-talk/issues/1435).
