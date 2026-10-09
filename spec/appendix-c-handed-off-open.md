# Appendix C: Handed off open

_Draws on:_ [ADR 0005](../docs/adr/0005-durability-is-a-deferred-extension.md), [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0027](../docs/adr/0027-layers-are-a-tooling-view-over-one-language.md), [ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md), [ADR 0032](../docs/adr/0032-the-spec-holds-the-rules-over-data-files-and-adrs-hold-the-reasons.md), [#86](https://github.com/odogono/odgn-talk/issues/86), [#87](https://github.com/odogono/odgn-talk/issues/87), [ADR 0039](../docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md), [ADR 0040](../docs/adr/0040-a-third-native-core-is-deferred-until-both-cores-conform.md), [ADR 0071](../docs/adr/0071-a-third-core-serves-embedding-outside-go-and-ts-after-the-message-layer-is-measured.md).

These are left open at handoff, on purpose. Everything else is written before it. An item that settles a language question gets an ADR, and the same change edits the Spec ([chapter 0](00-introduction.md#citing-adrs)).

## Written with the Cores

These need a working Core, so they are written during [Appendix B](appendix-b-implementation-order.md)'s first milestone.

- **Cost Model 1:** its rates are calibrated against both Cores once they pass the seed corpus. Until then, `costs.toml` holds the provisional Cost Model 0, whose rates aren't measured ([chapter 8](08-the-abstract-machine-and-the-cost-model.md#the-cost-model)). Language 1.0 is declared once Cost Model 1 exists ([ADR 0032](../docs/adr/0032-the-spec-holds-the-rules-over-data-files-and-adrs-hold-the-reasons.md)).
- **The TS Core's debug-pause hook:** documented in the [TS implementation guide](../impl/ts/README.md#tooling-debug-hooks), including inspection, stepping, fault breaks, paused wall time and replay landing for an early `Stop` or `CancelRun` ([chapter 12](12-sessions-and-tooling.md#the-debugger)).
- **The rest of the Corpus:** the seed cases are unblessed, and are blessed by the first Core ([Appendix B](appendix-b-implementation-order.md#blessing-the-seed-corpus)). The seed corpus also has no Disassembly Cases and no Session Transcripts, and its only load diagnostic is `pattern too large`. These are written as each Core can produce them, since `bless` writes the output lines.
- **The differential fuzzer:** a required practice, outside the Spec ([chapter 11](11-the-trace-and-conformance.md#conformance)). [The research](../docs/research/differential-fuzzing.md) proposes its generator, its minimiser and its oracles ([#86](https://github.com/odogono/odgn-talk/issues/86)), and it is built with the TS Core.

## Tooling

- **A tree-sitter grammar:** optional, for editors that want one. Like all tooling, it is not normative ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Language questions

None of these blocks an implementation. Each would be a language change.

- **Normative error messages:** the wording of a Core-raised `message` is outside parity, so text a Script builds from one is outside parity too, and no case may depend on it ([chapter 11](11-the-trace-and-conformance.md#what-is-recorded-and-when)). Making [chapter 6](06-errors-and-limits.md#messages)'s templates normative would close that gap.
- **A deadline for a whole Join,** beyond the waits of its members ([ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md)).
- **More from `locale`:** formatting currency Quantities in a Locale, formatting a whole date in a Locale's own pattern, and title case ([ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md)).
- **A Library's Operations:** whether a Library may declare the Operations it needs, so a Host can check them before any Import ([ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md)).

## Deferred until both Cores conform

- **A third Core for embedding outside Go and TS** ([#122](https://github.com/odogono/odgn-talk/issues/122), [ADR 0071](../docs/adr/0071-a-third-core-serves-embedding-outside-go-and-ts-after-the-message-layer-is-measured.md)): the gate in [ADR 0040](../docs/adr/0040-a-third-native-core-is-deferred-until-both-cores-conform.md) is met. A third Core, in Zig with a C interface, waits until the [Message Layer](09-embedding.md#the-message-layer) has been built and measured for an Elixir Host and a C Host, and has fallen short for one of them ([#532](https://github.com/odogono/odgn-talk/issues/532)). The browser stays on the TS Core.

## Deferred past 1.0

These are outside the language's first version, not open questions in it.

- **Durable, cross-Core snapshots:** a save restores only on the Core family that made it ([ADR 0005](../docs/adr/0005-durability-is-a-deferred-extension.md), [ADR 0008](../docs/adr/0008-same-core-save-restore.md)). A stable cross-Core format, and handling events while a Script is unloaded, are a later extension.
- **An Elixir Host:** it would drive the Go Core through the message layer, under `wasip1` or as a sidecar ([chapter 9](09-embedding.md#the-message-layer)), and gets no Core of its own ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).
