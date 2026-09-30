# Appendix B: Implementation order

_Draws on:_ [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md), [ADR 0032](../docs/adr/0032-the-spec-holds-the-rules-over-data-files-and-adrs-hold-the-reasons.md).

The Spec is handed off before any Core exists. This appendix gives the order the implementation goes in after that, and the part of the Conformance Corpus each milestone must pass. There are two milestones, and language 1.0 is declared between them or alongside the second:

1. [**The REPLs and the Playground**](#milestone-1-the-repls-and-the-playground), with the two Cores under them.
2. [**The runnable Example Hosts**](#milestone-2-the-example-hosts): a multi-tenant Go server, a Bun server, a browser Damocles slice and a shared parity example.

## Milestone 1: the REPLs and the Playground

A REPL is the smallest Host that drives a whole Core, and its Session Transcripts are corpus cases, so the REPLs come first ([ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md)). Each Core has one. The milestone goes in this order:

1. **The TS Core, its corpus runner and its REPL.** It comes first because the tooling, the Playground, the Bun server and the browser all run on it ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)), and because the differential fuzzer can run it against itself before the Go Core exists ([chapter 11](11-the-trace-and-conformance.md#conformance)).
2. **The Playground,** on the TS Core: the LSP in a worker, the formatter, live and replay debugging, and shared links ([chapter 12](12-sessions-and-tooling.md#the-playground)). It needs the TS Core's debug-pause hook ([Appendix C](appendix-c-handed-off-open.md)).
3. **The Go Core, its corpus runner and its REPL.** It shares no code with the TS Core, only the Spec, the Data Files and the Corpus ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)). So it can be built alongside the Playground, and it can start at any time, but it is checked against cases the TS Core has already blessed.

### Building a Core

Both Cores are built in the same order. Each step passes more of the seed corpus. Every case needs the first step, since the runner drives each case through the embedding interface and every Trace shows Fuel.

| Step | Builds | Chapters | Passes |
| --- | --- | --- | --- |
| 1 | The lexer, parser and checker, values, the Built-ins, expressions and statements, the lowering, the Abstract Machine and Cost Model 0, and enough of the embedding interface for the runner: making a Group, `Load`, `Deliver`, `Request`, `Pump`, `Inspect`, the value constructors, `EncodeValue` and a Trace sink. Also the display form, the Trace and the corpus runner | [1](01-lexical-structure.md) to [4](04-expressions-and-statements.md), [8](08-the-abstract-machine-and-the-cost-model.md), [9](09-embedding.md), [11](11-the-trace-and-conformance.md) | `text-model/`, and the Unicode test data of [chapter 1](01-lexical-structure.md#unicode) |
| 2 | Text Patterns, compiled to their Pike VM programs | [4](04-expressions-and-statements.md), [8](08-the-abstract-machine-and-the-cost-model.md#text-pattern-programs) | `text-patterns/` |
| 3 | Handlers, messages and scheduling with Fuel Slices, Joins and Decisions, errors, Libraries and the Standard Library, Capabilities and Host Objects | [5](05-handlers-messages-and-scheduling.md), [6](06-errors-and-limits.md), [7](07-libraries-and-the-standard-library.md), [9](09-embedding.md) | `errors/`, `decisions/` and `examples/` |
| 4 | Limits, Limit Faults and their rollback, cancellation and Stop Script | [6](06-errors-and-limits.md#limits) | `limits/` |
| 5 | Save and restore, Reload and extend Script | [10](10-save-and-restore.md) | `save-restore/`, and every case in the [save and restore replay](11-the-trace-and-conformance.md#save-and-restore-replays) |
| 6 | The Session Host and the REPL | [12](12-sessions-and-tooling.md) | Session Transcripts |

A case that leans on a later step passes once that step is built. `matching-fuel-exhaustion` and the two `pattern-size` cases in `text-patterns/` need step 4's limits, and `pattern-size-literal-limit` also needs step 5's Reload.

### Blessing the seed corpus

The seed cases are unblessed: their output lines are written by hand ([`corpus/README.md`](../corpus/README.md)). Milestone 1 turns them into blessed cases.

- **The TS Core blesses first.** `bless` writes a case only when every Core available agrees ([chapter 11](11-the-trace-and-conformance.md#bless)), so at first the TS Core blesses alone. A human reviews each diff against the hand-written lines. A line that turns out to be wrong is fixed then, with a Spec fix if the Spec was unclear. The Fuel, allocation and Persistent State figures that were estimates become Cost Model 0's real ones.
- **The Go Core** must then pass the blessed cases, in both replays. At each divergence the Spec decides which Core is wrong. If the Spec was unclear, it is fixed, and the case is blessed again with both Cores agreeing.
- **New cases:** the seed corpus has no Disassembly Cases or Session Transcripts, and only one load diagnostic ([Appendix C](appendix-c-handed-off-open.md#written-with-the-cores)). Milestone 1 adds them as each Core reaches the step that produces them.

### When it is done

Milestone 1 is done when both Cores conform to language 1.0-rc and Cost Model 0 ([chapter 11](11-the-trace-and-conformance.md#conformance)). Each passes every case, each Trace Case in both replays, and the Unicode test data, and each REPL replays every Session Transcript. Every case is blessed with both Cores agreeing, and CI runs the whole Corpus on both Cores for every change.

## Milestone 2: the Example Hosts

An Example Host is a small Host kept alongside the Spec to exercise the embedding interface and the Corpus end to end. It is not a product. Each is built on the interface of [chapter 9](09-embedding.md) alone, and each shows what its sketch showed ([ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md)):

- **A multi-tenant Go server,** on the Go Core: one Group per tenant, pumped in parallel by the `talk/driver` pool, Grants with per-Operation costs and binding data, `Charge`, limits set per plan, revoking a Grant, and Reload.
- **A Bun server,** on the TS Core: a webhook rules service with the real Clock, suspending Operations answered from Promises and cancelled through their `AbortSignal`, a synchronous database as an immediate Operation, and an HTTP request answered through `Request`, driven by `autoDrive`.
- **A browser Damocles slice,** on the TS Core: game events as Deliveries, one Pump per tick with a Fuel Slice, game time as the Clock, pause by not pumping, save anywhere with the game's catalogue ids as stable Host Object ids ([ADR 0008](../docs/adr/0008-same-core-save-restore.md)), a Message Path through Core-owned parents, and the shared `damocles` Library ([ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md)). The game's Go server, running in lockstep with this client, comes later.
- **A shared parity example:** the same Scripts and Host Inputs, [`corpus/examples/orders-pricing/`](../corpus/examples/orders-pricing/), replayed by the Go runner, and by the TS runner under Bun and in a browser. It also runs a Go Group and a TS Group in lockstep, comparing their Group Fingerprints before they start ([chapter 9](09-embedding.md#the-pump-and-the-group-fingerprint)).

The Corpus each must pass:

- **Its own case:** each Example Host records a Trace of its Scripts, and that Trace is committed as a Trace Case under `corpus/examples/`. Both Cores' runners must pass it, in both replays, since a Trace replays without the Host that took it ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)).
- **The whole Corpus still passes** on both Cores, with every case the milestone adds.
- **Divergences:** any a lockstep Host finds becomes a case, with a Spec fix if the Spec was unclear ([chapter 11](11-the-trace-and-conformance.md#conformance)).

## Language 1.0

Language 1.0 is declared once both Cores pass the seed corpus, which is the end of milestone 1, and Cost Model 1 has been calibrated against them ([ADR 0032](../docs/adr/0032-the-spec-holds-the-rules-over-data-files-and-adrs-hold-the-reasons.md), [Appendix C](appendix-c-handed-off-open.md#written-with-the-cores)). The Example Hosts aren't a condition.

- **The versions:** [`version.toml`](data/version.toml) becomes `1.0`, and [`costs.toml`](data/costs.toml) Cost Model 1.
- **Re-blessing:** a new version re-blesses the whole Corpus, with every case's `[versions]` ([chapter 11](11-the-trace-and-conformance.md#bless)).
- **After it:** a change to the Cost Model is a new Cost Model version, never a change in place ([chapter 8](08-the-abstract-machine-and-the-cost-model.md#changes-to-cost-model-0)).
