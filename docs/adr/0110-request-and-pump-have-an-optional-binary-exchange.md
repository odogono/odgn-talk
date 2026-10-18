---
status: proposed
---

# Request and Pump have an optional binary exchange

For [#1245](https://github.com/odogono/odgn-talk/issues/1245), we propose a narrowly negotiated binary Message Layer feature for Request, Function calls and Pump, plus explicit combined admission-and-Pump operations. JSON remains available for other messages and carries needs, their answers and inline events. This decision will supersede [ADR 0098](0098-the-message-layer-may-carry-binary-frames.md) only after the experiment below passes; ADR 0098 remains the accepted decision in the meantime.

The [proposed contract](../../spec/embedding/request-pump-binary.md) preserves synchronous admission for existing APIs. A combined call claims the Group worker, admits once and Pumps once; its result distinguishes admission failure from Pump failure after admission. Temporary Host correlation tokens allow cancellation before the Host receives the Core-assigned delivery id. They do not replace Delivery identity.

The binary Value codec is language-neutral and independent of WASM. A browser Host can transfer its buffers to a worker running the TS Core. Folio's application messages are a different boundary and retain their structured-clone transport pending separate measurement.

## Considered Options

- ADR 0098's all-binary Session encodes every message before the measured hot path can benefit. The narrower feature keeps migration and callback handling bounded.
- Deferring ordinary Request admission until Pump breaks validation, mailbox reservation and delivery identity. Combined execution therefore has an explicit API.
- An admission receipt preserves early identity but adds a round trip. Exchange-scoped Host tokens preserve cancellation without that receipt.
- Generic map envelopes reuse the existing data model. Specialized envelopes remove field-name processing but add another schema. Both are measured before selection.
- Core snapshots couple Hosts to a Core's persistence format. The existing canonical binary Value tags instead define the shared representation.

## Acceptance and consequences

Measure unchanged `BackendRequest` and equivalent native/Zig combined Request benchmarks in the same jobs on Linux amd64, Linux arm64 and macOS arm64. Both must reach at most 3× native, without native regression. Function-call measurements are recorded without an additional gate. Prefer generic envelopes if both pass, unless specialized envelopes improve combined latency by at least 10% on every platform; choose specialized envelopes if only they pass.

After profiling and one targeted optimization pass, a remaining failure stops broader implementation for maintainer review. Record evidence, not a claim of impossibility. Go/Zig is the experiment; TS, Elixir and C public APIs follow only after the gates pass. Elixir's combined operation requires an explicitly released pending handle with repeatable awaits; releasing it or timing out an await does not cancel execution.
