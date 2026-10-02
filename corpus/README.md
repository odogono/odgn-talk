# The Conformance Corpus

The cases both Cores must pass, bit for bit ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)). Their formats are in [chapter 11](../spec/11-the-trace-and-conformance.md) of the Spec.

| Directory | What its cases pin |
| --- | --- |
| [`examples/`](examples/) | worked examples of the format |
| [`save-restore/`](save-restore/) | save and restore: mid-Segment preemption, pending-call settlements, cross-Script `send … and wait` pairs, variables-only restores, Grants and Libraries the Host no longer has, overdue `wait`s after a restore, and reissue Fuel charges, debt and cutoff ([chapter 10](../spec/10-save-and-restore.md)) |
| [`limits/`](limits/) | exhaustion points, at dispatch too, Segment rollback, virtual-Clock deadlines, and each counted limit at its conformance minimum ([chapter 6](../spec/06-errors-and-limits.md)) |
| [`text-patterns/`](text-patterns/) | successive searches past empty matches, leftmost-first `or`, greedy defaults, matching Fuel, pattern size and repetition limits, and the canonical source of a pattern that starts with a group ([chapter 8](../spec/08-the-abstract-machine-and-the-cost-model.md#text-pattern-programs)) |
| [`bytes/`](bytes/) | building and matching Bytes with Binary Patterns, Bytes chunks and searches, build errors, and the Value Encoding of Bytes ([chapter 4](../spec/04-expressions-and-statements.md#binary-patterns)) |
| [`quantities/`](quantities/) | arithmetic and `as` through Base Units, `incompatible units`, and the Value Encoding of Quantities and ranges ([chapter 3](../spec/03-values.md#quantities)) |
| [`text-model/`](text-model/) | whole-Character boundaries, NFC at join seams and at the Host's text constructor, `word` and `word break` on punctuation, chunk padding on writes, and out-of-range reads ([chapter 3](../spec/03-values.md)) |
| [`errors/`](errors/) | whole error maps, with their keys in order ([chapter 6](../spec/06-errors-and-limits.md#errors)) |
| [`dates/`](dates/) | Civil Date and Instant arithmetic, offsets, the date Built-ins and their errors, and the Value Encoding of dates ([chapter 3](../spec/03-values.md#dates-and-times)) |
| [`libraries/`](libraries/) | calls into Libraries, their defaults, Constants, Handlers and Function Values, errors and Limit Faults in Library code, adding Libraries to a Group, and direct/transitive `needs` with caller Grants and suspension ([chapter 7](../spec/07-libraries-and-the-standard-library.md#libraries)) |
| [`objects/`](objects/) | Host Objects: Deliveries routed by parents, `pass` and climbing, `the target`, sends to objects and up the Message Path, and properties ([chapter 5](../spec/05-handlers-messages-and-scheduling.md#the-message-path)) |
| [`suspension/`](suspension/) | `wait`, `wait for` and its block form, Joins with their answers, failures and abandoned members, suspending Operations with their answers, failures and `maxPending`, `send … and wait` with its reply, `send failed` and `MaxWait`, waits inside called Handlers and Lambdas, and Persistent State at a suspension ([chapter 5](../spec/05-handlers-messages-and-scheduling.md#suspension-points)) |
| [`capabilities/`](capabilities/) | immediate and fire-and-forget Capability calls through Grants, Stubs and `Charge`, argument Shapes and trailing Optional arguments, Host failures and `host error`, the load checks of `ask`, `tell` and `say`, Grant trimming with Library needs, revocation during a pending call, all five Standard Capabilities, and faults at a call ([chapter 9](../spec/09-embedding.md#capabilities)) |
| [`stdlib/`](stdlib/) | calls into the stdlib Libraries with no `add-library` line, and errors raised in stdlib code naming the Script's call ([chapter 7](../spec/07-libraries-and-the-standard-library.md#the-standard-library), [ADR 0037](../docs/adr/0037-errors-raised-in-stdlib-code-point-at-the-scripts-call.md)) |
| [`math/`](math/) | the correctly rounded number functions, the Float Built-ins, and their domain errors ([chapter 7](../spec/07-libraries-and-the-standard-library.md#numbers)) |
| [`decisions/`](decisions/) | Decisions: first-Segment seals across preemption, veto and pass, dispatch and pending waits, undecided errors and faults, and Broadcast recipient aggregation ([ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md)) |
| [`cancellation/`](cancellation/) | Broadcast recipients, Queueing Policies, cancelled cleanup and its failures, Host crossings, owner disposal and sticky Stop ([chapters 5 and 6](../spec/06-errors-and-limits.md#cancellation-and-stop)) |
| [`reload/`](reload/) | Reload carry/reset and discarded Runs, extension code units and their state cap, transitive Library replacement, and stale Function Values ([chapter 10](../spec/10-save-and-restore.md#reload-and-extend)) |
| [`builtins/`](builtins/) | reading a value's kind with `kindOf`, and a Function Value's arity and name with `functionArity` and `functionName`, stale ones included, and a Host Object's Object Kind with `objectKind`, disposed ones included ([chapter 7](../spec/07-libraries-and-the-standard-library.md#values), [ADR 0043](../docs/adr/0043-values-are-introspected-through-built-in-functions.md), [ADR 0044](../docs/adr/0044-a-host-objects-object-kind-is-read-with-a-built-in.md)) |
| [`disassembly/`](disassembly/) | Disassembly Cases: the lowering of expressions, Containers, Destructuring, control flow and `try`, calls and Lambdas, and messages and waiting, which between them emit every instruction ([chapter 8](../spec/08-the-abstract-machine-and-the-cost-model.md#the-lowering)) |

## Seed blessing

All current Trace Cases are blessed by the TS Core, the only available Core. The last five seeds now have explicit Cost Model derivations in their headers: `fuel-alloc-minimums`, `persistent-state-minimum`, `matching-fuel-exhaustion`, `canonical-source-leading-group` and `replace-all-empty-matches`. Their first blessing awaits human review.

The seed cases were written before any Core existed. Until a case is blessed, its `case.trace` has its `>` Host Input lines and its Core output lines written by hand, and says so in its header:

```text
# Unblessed: the output lines are written by hand, not by bless.
```

- **What a case pins** (its records, their order, its ids, values, error codes, instructions and source positions) is worked out from the Spec, and is what a Core is checked against.
- **Fuel, allocation and Persistent State figures** are estimates, except where a case says in a comment that it pins one and shows how it is worked out from Cost Model 0.
- **Code identities** are left out of `load` and `add-library` lines, which an author may do, and bless fills them in.
- **Instruction indices** in `at=` come from `bun tools/machine/check.ts --dis <file>`, which isn't normative. Blessing checks them against a Core.

A human reviews each case's diff when it is first blessed, and a case whose hand-written lines turn out to be wrong is fixed then, with a Spec fix if the Spec was unclear.

The two `needs-*` cases in `libraries/` cover missing transitive Grants and suspension through a Library frame.

The `grants-as-used`, `revoke-in-flight` and `revoke-reissue` cases in `capabilities/` cover trimming, code-change checks and revocation without abandoning a pending call, including save/restore replay and explicit Reissue.

The `standard-clock`, `standard-timer` and `standard-clock-fuel` cases use fixed Standard Capability declarations. They cover nanosecond-accurate Pump readings without Stubs, Host timer calls and ordinary Deliveries, Library needs, and rollback when a call's declared cost exhausts Fuel.

The `standard-console`, `standard-console-cancel` and `standard-console-timeout` cases cover Console calls through fixed declarations: a Library's `say` of nested Function Values, an empty input line, extra Fuel, cancellation and late answers, and the human-input deadline overriding a shorter Script `MaxWait`.

The `standard-locale`, `standard-locale-ranks` and `standard-locale-validation` cases cover all eight Locale Operations, Host data and fallback, stable sorting through dense ranks, malformed answers, option and tag checks, and save/restore replay.

The `standard-calendar`, `standard-calendar-errors` and `standard-calendar-validation` cases cover the six fixed Calendar Operations, optional arguments, valid and malformed catalogue failures, uncharged domain checks and result refinements, including save/restore replay.

The `optional-args`, `optional-args-join` and `optional-args-fuel` cases cover trailing Optional Capability arguments: omission and explicit Nothing through a Library, immediate and fire-and-forget costs, Join members with different supplied counts, and rollback when an omitted-argument call cannot pay its declared Fuel.

Every current Trace Case runs in CI, including the limits at their conformance minimums and all Text Pattern seeds. Its Fuel, allocation and Persistent State figures are Cost Model 0's. The Go Core must agree before a case counts as blessed by both.


## The Disassembly Cases

The cases under [`disassembly/`](disassembly/) were written with the TS Core's lowering, and their expected `.dis` files were written by `bun run corpus:run --bless`, with the TS Core the only Core available ([chapter 11](../spec/11-the-trace-and-conformance.md#bless)). They await their first human review, as every case does, and the Go Core must agree before they count as blessed by both.

## Checking

```sh
bun run corpus:check          # what CI runs: every case reads as chapter 11 says
bun run grammar:check         # every .talk file here parses
bun run machine:check         # and lowers
bun run corpus:run            # the TS Core runs the case kinds it implements, and blessed Trace Cases
bun run corpus:run text-model/chunk-write-padding   # replays a named case, blessed or not
```

[`tools/corpus/check.ts`](../tools/corpus/check.ts) reads each `case.toml` and `case.trace` against [`corpus.toml`](../spec/data/corpus.toml) and the display form. It doesn't run anything, so a case that passes it can still be wrong ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).
