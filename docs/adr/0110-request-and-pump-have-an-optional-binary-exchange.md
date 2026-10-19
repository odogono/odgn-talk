---
status: accepted
---

# Request and Pump have an optional binary exchange

For [#1245](https://github.com/odogono/odgn-talk/issues/1245), we propose a narrowly negotiated binary Message Layer feature for Request, Function calls and Pump, plus explicit combined admission-and-Pump operations. JSON remains available for other messages, unnegotiated callbacks and inline events. It supersedes [ADR 0098](0098-the-message-layer-may-carry-binary-frames.md). The fields envelope is selected.

The [proposed contract](../../spec/embedding/request-pump-binary.md) preserves synchronous admission for existing APIs. A combined call claims the Group worker, admits once and Pumps once; its result distinguishes admission failure from Pump failure after admission. Temporary Host correlation tokens allow cancellation before the Host receives the Core-assigned delivery id. They do not replace Delivery identity.

The binary Value codec is language-neutral and independent of WASM. A browser Host can transfer its buffers to a worker running the TS Core. Folio's application messages are a different boundary and retain their structured-clone transport pending separate measurement.

## Considered Options

- ADR 0098's all-binary Session encodes every message before the measured hot path can benefit. The narrower feature keeps migration and callback handling bounded.
- Deferring ordinary Request admission until Pump breaks validation, mailbox reservation and delivery identity. Combined execution therefore has an explicit API.
- An admission receipt preserves early identity but adds a round trip. Exchange-scoped Host tokens preserve cancellation without that receipt.
- Generic map envelopes reuse the existing data model. Specialized envelopes remove field-name processing but add another schema. Both are measured before selection.
- Core snapshots couple Hosts to a Core's persistence format. The existing canonical binary Value tags instead define the shared representation.

## Acceptance and consequences

We first required binary Zig to reach at most 3× native on Linux amd64, Linux arm64 and macOS arm64. [#1254 measured](../research/request-pump-binary.md#gate-measurements-1254) 3.5–6× after one optimization pass. About 70% of a round trip is guest execution, which the envelope can't reduce. So that limit measures the guest, not this transport, and we amended the gate (#1245).

The binary exchange is accepted when it beats the JSON Message Layer by at least 25% on every platform for both the unchanged `BackendRequest` and the combined Request, measured in the same job, with no native regression. Fields passed on every platform, at 27–43%. We select it over map, which was 10–19% slower on the unchanged Request in every job. Function-call measurements are recorded without a gate.

The ≤3×-native target remains a goal for the Zig guest, tracked in #1267 and not a condition of this transport. Go/Zig was the experiment; the TS, Elixir and C public APIs now follow. Elixir's combined operation requires an explicitly released pending handle with repeatable awaits; releasing it or timing out an await does not cancel execution.

- Amended by #1245: the gate was relative to native, and is now relative to JSON. The ≤3×-native goal moved to #1267.
- Amended by #1311: the `op`, `prop`, `effect` and `release` needs and their results may also cross in the fields envelope, under a separate `callbacks-fields-v1` feature. Other needs, their answers and inline events stay JSON. A local A/B on Apple Silicon measured `Run/host/immediate` 48% faster.
- Amended by #1315: the Elixir Host can negotiate `callbacks-fields-v1` with `binary_callbacks: true`, independently of Request/Pump. It defaults to JSON callbacks because they measured faster on the Elixir Host; #1316 tracks the codec work. Host Object property callbacks remain unavailable through its public API; property needs keep their existing safe refusal.
- Amended by #1334: the map layout, `request-pump-map-v1`, is retired. The Spec defines only the JSON and fields layouts, guests refuse the feature in `hello` as they refuse any unknown feature, and no Host keeps map encode or decode code.
- Amended by #1329: `load-fields-v1` independently negotiates binary Load inputs with raw UTF-8 source and optional Group creation fields. A Host may reserve a Group handle locally until first use, saving `new-group` on a first Load and avoiding `drop-group` for an unused Group. Load replies retain their JSON form and existing validation and Trace semantics.
