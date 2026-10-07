# Milestone 1 first-blessing review package (#141)

Approval status: **pending**. This package collects the last expectations that
still carry an `Unblessed` marker, so the maintainer can give the first-blessing
review that [#141](https://github.com/odogono/odgn-talk/issues/141) and
[Appendix B](../../../spec/appendix-b-implementation-order.md#when-it-is-done)
require. Execution agreement is evidence for that review, not approval
([chapter 11](../../../spec/11-the-trace-and-conformance.md#bless)).

The 22 step-3 Traces approved when #134 closed are recorded separately in
[#414](https://github.com/odogono/odgn-talk/pull/414) and are not part of this
package.

## Cross-Core evidence

Checked on 2026-10-07 at `origin/main` `43949e7`, which includes the cross-Core
`bless` from [#413](https://github.com/odogono/odgn-talk/pull/413):

```sh
bun run corpus:bless <each case below>
```

All 25 cases report `BLESSED … (TS and Go agree)`, and `git status` shows no
changed file afterwards. Each expectation below is therefore exactly what both
the TS and Go Cores produce, in ordinary and save/restore replay. No
expectation, Host Input or comment was changed for this package.

## What to review

For each case, check the expectation against the cited Spec rules:

- record order;
- error fields and source positions;
- Fuel, allocation and retained state under Cost Model 0;
- for Disassembly, slots and instruction positions.

The linked evidence records give the derivations already worked out. An
expectation that contradicts the Spec is fixed instead, with a Spec fix if the
Spec was unclear.

### Collecting Clause — #380 (7 expectations)

Spec: [ADR 0059](../../adr/0059-a-repeat-may-collect-its-results.md), chapter 4 loops and chapter 8 lowering.
Evidence: [Collecting review record](../collecting/README.md).

| Expectation | Pins |
| --- | --- |
| [collecting/zero-passes](../../../corpus/collecting/zero-passes/case.trace) | Every finite head initializes an empty target when no pass runs |
| [collecting/next-filter](../../../corpus/collecting/next-filter/case.trace) | `next repeat` skips collection; the expression sees the body's writes |
| [collecting/exit](../../../corpus/collecting/exit/case.trace) | Early exit skips collection in iterator and forever loops |
| [collecting/partial-error](../../../corpus/collecting/partial-error/case.trace) | A failing collected expression keeps earlier elements |
| [collecting/condition-target](../../../corpus/collecting/condition-target/case.trace) | `while`/`until` read the target so far; Lists collect element-wise |
| [collecting/waiting-body](../../../corpus/collecting/waiting-body/case.trace) | Partial lists survive Pumps and restore |
| [disassembly/collecting](../../../corpus/disassembly/collecting/collect.dis) | Initialization and append positions for every head and destructuring; its marker is in `case.toml` |

### Suspension retention — #281 (8 Traces)

Spec: chapter 6 Persistent State checks after suspension; chapter 8 pending-call
(48 bytes), captured-Value and event-filter sizes. Evidence:
[retention audit](../suspension-retention/README.md), which lists each case's
exact fault/suspend limit and byte breakdown.

- [limits/ask-wait-retention](../../../corpus/limits/ask-wait-retention/case.trace)
- [limits/foreign-call-retention](../../../corpus/limits/foreign-call-retention/case.trace)
- [limits/event-capture-wait-retention](../../../corpus/limits/event-capture-wait-retention/case.trace)
- [limits/event-capture-block-retention](../../../corpus/limits/event-capture-block-retention/case.trace)
- [limits/event-object-wait-retention](../../../corpus/limits/event-object-wait-retention/case.trace)
- [limits/event-object-block-retention](../../../corpus/limits/event-object-block-retention/case.trace)
- [limits/join-pending-retention](../../../corpus/limits/join-pending-retention/case.trace)
- [limits/join-early-answer-retention](../../../corpus/limits/join-early-answer-retention/case.trace)

### Argument Labels and Selectors — #351 (4 cases, 5 files)

Spec: chapter 2 Selectors and load diagnostics; chapter 5 Message Paths;
chapter 12 Session Entries. Origin: [PR #354](https://github.com/odogono/odgn-talk/pull/354).
No separate review record exists, so these need the closest reading.

| Expectation | Pins |
| --- | --- |
| [load-diagnostics/argument-labels](../../../corpus/load-diagnostics/argument-labels/case.trace) | Labelled pass checks, syntax traps, suspension and Selector clashes |
| [objects/argument-labels](../../../corpus/objects/argument-labels/case.trace) | Labelled Selectors follow the Message Path and keep the Target |
| [suspension/argument-labels](../../../corpus/suspension/argument-labels/case.trace) | Every Host message input checks Selectors synchronously |
| [sessions/argument-labels](../../../corpus/sessions/argument-labels/session.transcript) and its [case.trace](../../../corpus/sessions/argument-labels/case.trace) | Session Entries recognise a Handler Selector by its first word |

### Text Pattern regressions — #133 (3 Traces)

Spec: chapter 8 Text Pattern program sizes; chapter 11 canonical source;
chapter 4 wrong-kind splice. Origin: [PR #264](https://github.com/odogono/odgn-talk/pull/264).
Each header derives its instruction counts, sizes and charges.

- [text-patterns/counted-program-sizes](../../../corpus/text-patterns/counted-program-sizes/case.trace)
- [text-patterns/empty-literal-composition](../../../corpus/text-patterns/empty-literal-composition/case.trace)
- [text-patterns/splice-wrong-kind](../../../corpus/text-patterns/splice-wrong-kind/case.trace)

### Differential-fuzzer regressions — #363 (2 Traces)

Origin: [PR #376](https://github.com/odogono/odgn-talk/pull/376). The headers
explain each ordering.

| Expectation | Pins |
| --- | --- |
| [errors/queued-error-before-parked-run](../../../corpus/errors/queued-error-before-parked-run/case.trace) | A `, queued` clause's `error` message runs before the parked Run. You already decided this ordering in #375; the review is of the Trace itself |
| [save-restore/preempted-join-keeps-pending-members](../../../corpus/save-restore/preempted-join-keeps-pending-members/case.trace) | A save keeps a preempted Join's started members pending (chapter 10); TS fix #374 |

### Request cancellation correction — #364 (1 Trace)

[counters/faults-and-cleanup](../../../corpus/counters/faults-and-cleanup/case.trace):
only `> deliver d2` becomes `> request d2`; the other 33 records are
unchanged. Evidence: the
[Spec derivation](../delivery-cancellation/README.md#queued-request-cancellation-correction-364).

## After approval

Replace each approved marker with
`# First blessing approved by the maintainer on <date> for #141.`
For `disassembly/collecting`, the marker is in `case.toml`. Change nothing else.
Record the approval and its exact scope here. Then check that `bun run
corpus:run`, `go -C impl/go run ./cmd/corpus --check-passing` and
`bun run corpus:check` still pass. A case that is not approved keeps its marker
and gets an issue for its correction.
