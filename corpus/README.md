# The Conformance Corpus

The cases both Cores must pass, bit for bit ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)). Their formats are in [chapter 11](../spec/11-the-trace-and-conformance.md) of the Spec.

## Checking

Run these commands from the repository root. Both runners resolve relative case selectors under `corpus/`, not the shell's current directory; use `text-model/chunk-write-padding`, not `corpus/text-model/chunk-write-padding`. Absolute case directories also work.

| Runner | Entry point | Selection and gate |
| --- | --- | --- |
| TS | [`impl/ts/tools/corpus.ts`](../impl/ts/tools/corpus.ts), via `bun run corpus:run` | A named case or directory; `--list` reports support. Default execution excludes unblessed Trace Cases and Transcripts. |
| Go | [`impl/go/cmd/corpus/main.go`](../impl/go/cmd/corpus/main.go), run inside `impl/go` | Named case directories; `--list` reports support, and `--check-passing` enforces [`corpus-passing.txt`](../impl/go/corpus-passing.txt). |

For Go, after the [build/test prerequisites](../impl/go/README.md#build-and-test):

```sh
(cd impl/go && go run ./cmd/corpus text-model/chunk-write-padding)
(cd impl/go && go run ./cmd/corpus --check-passing)
```

Only the TS runner has `--bless`, and it requires named cases; it writes Disassembly, Trace or Transcript expectations, not encoding cases. Producing expectations is not first-blessing approval: follow [the agreement and human-review rules](../spec/11-the-trace-and-conformance.md#bless) and the [seed review notes](#seed-blessing). The Go runner never writes expectations.

```sh
bun run corpus:check          # what CI runs: every case reads as chapter 11 says
bun run grammar:check         # every .talk file here parses
bun run machine:check         # and lowers
bun run corpus:run            # the TS Core runs the case kinds it implements, and blessed Trace Cases
bun run corpus:run text-model/chunk-write-padding   # replays a named case, blessed or not
```

[`tools/corpus/check.ts`](../tools/corpus/check.ts) reads each `case.toml` and `case.trace` against [`corpus.toml`](../spec/data/corpus.toml) and the display form. It doesn't run anything, so a case that passes it can still be wrong ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Case navigation

| Directory | What its cases pin |
| --- | --- |
| [`load-diagnostics/`](load-diagnostics/) | rejected loads: each step 1 diagnostic family and its source position ([chapter 2](../spec/02-grammar.md#load-time-diagnostics)); new TS-blessed cases awaiting human review (#250) |
| [`examples/`](examples/) | worked examples of the format |
| [`save-restore/`](save-restore/) | save and restore: mid-Segment preemption, pending-call settlements, cross-Script `send … and wait` pairs, variables-only restores, Grants and Libraries the Host no longer has, overdue `wait`s after a restore, and reissue Fuel charges, debt and cutoff ([chapter 10](../spec/10-save-and-restore.md)) |
| [`counters/`](counters/) | lifetime work and current state through preemption, faults, cleanup, Stop, code changes and both restore policies ([chapter 9](../spec/09-embedding.md#script-counters)) |
| [`limits/`](limits/) | exhaustion points, at dispatch too, Segment rollback, virtual-Clock deadlines, and each counted limit at its conformance minimum ([chapter 6](../spec/06-errors-and-limits.md)) |
| [`text-patterns/`](text-patterns/) | successive searches past empty matches, leftmost-first `or`, greedy defaults, matching Fuel, pattern size and repetition limits, and the canonical source of a pattern that starts with a group ([chapter 8](../spec/08-the-abstract-machine-and-the-cost-model.md#text-pattern-programs)) |
| [`bytes/`](bytes/) | building and matching Bytes with Binary Patterns, Bytes chunks and searches, build errors, and the Value Encoding of Bytes ([chapter 4](../spec/04-expressions-and-statements.md#binary-patterns)) |
| [`quantities/`](quantities/) | arithmetic and `as` through Base Units, `incompatible units`, and the Value Encoding of Quantities and ranges ([chapter 3](../spec/03-values.md#quantities)) |
| [`text-model/`](text-model/) | whole-Character boundaries, NFC at join seams and at the Host's text constructor, `word` and `word break` on punctuation, chunk padding on writes, and out-of-range reads ([chapter 3](../spec/03-values.md)) |
| [`errors/`](errors/) | whole error maps, with their keys in order, queued error delivery, Handler dispatch and Guard skips, `during` bindings, and error backstops ([chapter 6](../spec/06-errors-and-limits.md#errors)) |
| [`dates/`](dates/) | Civil Date and Instant arithmetic, offsets, the date Built-ins and their errors, and the Value Encoding of dates ([chapter 3](../spec/03-values.md#dates-and-times)) |
| [`libraries/`](libraries/) | calls into Libraries, their defaults, Constants, Handlers and Function Values, errors and Limit Faults in Library code, adding Libraries to a Group, and direct/transitive `needs` with caller Grants and suspension ([chapter 7](../spec/07-libraries-and-the-standard-library.md#libraries)) |
| [`objects/`](objects/) | Host Objects: Deliveries routed by parents, `pass` and climbing, `the target`, sends to objects and up the Message Path, moving mailbox messages, object event filters and properties ([chapter 5](../spec/05-handlers-messages-and-scheduling.md#the-message-path)) |
| [`suspension/`](suspension/) | `wait`, `wait for` and its block form, Joins with their answers, failures and abandoned members, suspending Operations with their answers, failures and `maxPending`, `send … and wait` with its reply, `send failed` and `MaxWait`, waits inside called Handlers and Lambdas, and Persistent State at a suspension ([chapter 5](../spec/05-handlers-messages-and-scheduling.md#suspension-points)) |
| [`capabilities/`](capabilities/) | immediate and fire-and-forget Capability calls through Grants, Stubs and `Charge`, argument Shapes and trailing Optional arguments, Host failures and `host error`, the load checks of `ask`, `tell` and `say`, Grant trimming with Library needs, revocation during a pending call, all five Standard Capabilities, and faults at a call ([chapter 9](../spec/09-embedding.md#capabilities)) |
| [`stdlib/`](stdlib/) | calls into the stdlib Libraries with no `add-library` line, and errors raised in stdlib code naming the Script's call ([chapter 7](../spec/07-libraries-and-the-standard-library.md#the-standard-library), [ADR 0037](../docs/adr/0037-errors-raised-in-stdlib-code-point-at-the-scripts-call.md)) |
| [`math/`](math/) | the correctly rounded number functions and fractional `^`, the Float Built-ins, and their domain errors ([chapter 7](../spec/07-libraries-and-the-standard-library.md#numbers)) |
| [`functions/`](functions/) | Host and foreign Function Value calls, defaults, Capability callbacks, replies, staleness and cancellation ([chapters 5](../spec/05-handlers-messages-and-scheduling.md#function-values-in-another-script) and [9](../spec/09-embedding.md#function-values)) |
| [`decisions/`](decisions/) | Decisions: first-Segment seals across preemption, veto and pass, dispatch and pending waits, undecided errors and faults, and Broadcast recipient aggregation ([ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md)) |
| [`cancellation/`](cancellation/) | Broadcast recipients, Queueing Policies, cancelled cleanup and its failures, Host crossings, owner disposal and sticky Stop ([chapters 5 and 6](../spec/06-errors-and-limits.md#cancellation-and-stop)) |
| [`reload/`](reload/) | Reload carry/reset and discarded Runs, extension code units and their state cap, transitive Library replacement, and stale Function Values ([chapter 10](../spec/10-save-and-restore.md#reload-and-extend)) |
| [`builtins/`](builtins/) | reading a value's kind with `kindOf`, and a Function Value's arity and name with `functionArity` and `functionName`, stale ones included, and a Host Object's Object Kind with `objectKind`, disposed ones included ([chapter 7](../spec/07-libraries-and-the-standard-library.md#values), [ADR 0043](../docs/adr/0043-values-are-introspected-through-built-in-functions.md), [ADR 0044](../docs/adr/0044-a-host-objects-object-kind-is-read-with-a-built-in.md)) |
| [`disassembly/`](disassembly/) | Disassembly Cases: the lowering of expressions, Containers, Destructuring, control flow and `try`, calls and Lambdas, and messages and waiting, which between them emit every instruction ([chapter 8](../spec/08-the-abstract-machine-and-the-cost-model.md#the-lowering)) |
| [`sessions/`](sessions/) | Session Transcripts: Entries, echoes and `say`, implicit Script Variables, declarations and redefinitions, rejected Entries, background lines, a real Clock's `@` readings, deadline Pumps and `read` answers, mock Operations with their Stubs, answers and failures, a virtual Clock, redefinition while a Run is suspended, `:cancel`, `:runs`, `:mailbox`, `:vars`, `:limits`, `:save` and `:restore` with an adopted call, user Libraries and `:export`, and refused Session Commands ([chapter 12](../spec/12-sessions-and-tooling.md#session-transcripts)) |

## Seed blessing

The original 198 seed cases execute on the TS Core, which supplied their first blessings. Every seed's first blessing has had its human review except the Session Transcripts' and scoped-effect cases' (below), the last being the five seeds whose headers derive their figures from Cost Model 0 (`fuel-alloc-minimums`, `persistent-state-minimum`, `matching-fuel-exhaustion`, `canonical-source-leading-group` and `replace-all-empty-matches`), reviewed in [#126](https://github.com/odogono/odgn-talk/issues/126). The four Value Encoding cases' hand-written bytes are reproduced exactly by the TS Core and were reviewed with them. The Go Core now replays its supported subset through its public embedding API; see its [passing gate](../impl/go/README.md#corpus-runner).

The three new Text Pattern regression cases (`counted-program-sizes`, `empty-literal-composition` and `splice-wrong-kind`) pin chapter 8's program sizes, chapter 11's empty-group canonical source and chapter 4's wrong-kind splice fields. Both Cores reproduce their complete Traces. They retain `Unblessed` headers pending human review of the first blessing; no existing expectation was re-blessed for these fixes.

The two new error-delivery regression cases (`handler-delivery` and
`handler-backstop`) pin chapter 6's separate error Runs, FIFO order, `during`
bindings before Guards, unmatched-message handling and prevention of recursive
error delivery. They also pin chapter 8's dispatch costs, retained mailbox state
and Fuel Slice preemption. Both Cores agree on their complete Traces; their
`Unblessed` headers remain pending human review of the first blessing.

The seed cases were written before any Core existed. Until a case is blessed, its `case.trace` has its `>` Host Input lines and its Core output lines written by hand, and says so in its header:

```text
# Unblessed: the output lines are written by hand, not by bless.
```

- **What a case pins** (its records, their order, its ids, values, error codes, instructions and source positions) is worked out from the Spec, and is what a Core is checked against.
- **Fuel, allocation and Persistent State figures** are estimates, except where a case says in a comment that it pins one and shows how it is worked out from Cost Model 0.
- **Code identities** are left out of `load` and `add-library` lines, which an author may do, and bless fills them in.
- **Instruction indices** in `at=` come from `bun tools/machine/check.ts --dis <file>`, which isn't normative. Blessing checks them against a Core.

A human reviews each case's diff when it is first blessed, and a case whose hand-written lines turn out to be wrong is fixed then, with a Spec fix if the Spec was unclear.

The three `counters/` cases pin lifetime work, mailbox and live state, fault rollback, failed cleanup, Reload/Extend and full or variables-only restore.

The `event-test-slice-debt` and `event-test-group-cap` cases in `suspension/` pin observation Fuel, atomic waiter checks, dispatch ordering and slice debt. The `event-tests-fault-on-resume` case in `limits/` pins uncapped observation charges and the waiting Run's fault at its next resumed instruction. All three pass full and save/restore replay.

The `moving-mailbox`, `moving-climb` and `wait-target` cases in `objects/` pin transfer admission and ordering, queued path continuation, fixed Targets and object-filtered event observation.

The four `functions/` cases cover Host and foreign calls, cancellation, defaults and previously exported callbacks returned through Capability Stubs and answers.

The two `needs-*` cases in `libraries/` cover missing transitive Grants and suspension through a Library frame.

The `grants-as-used`, `revoke-in-flight` and `revoke-reissue` cases in `capabilities/` cover trimming, code-change checks and revocation without abandoning a pending call, including save/restore replay and explicit Reissue.

The `standard-clock`, `standard-timer` and `standard-clock-fuel` cases use fixed Standard Capability declarations. They cover nanosecond-accurate Pump readings without Stubs, Host timer calls and ordinary Deliveries, Library needs, and rollback when a call's declared cost exhausts Fuel.

The `standard-console`, `standard-console-cancel` and `standard-console-timeout` cases cover Console calls through fixed declarations: a Library's `say` of nested Function Values, an empty input line, extra Fuel, cancellation and late answers, and the human-input deadline overriding a shorter Script `MaxWait`.

The `standard-locale`, `standard-locale-ranks` and `standard-locale-validation` cases cover all eight Locale Operations, Host data and fallback, stable sorting through dense ranks, malformed answers, option and tag checks, and save/restore replay.

The `standard-calendar`, `standard-calendar-errors` and `standard-calendar-validation` cases cover the six fixed Calendar Operations, optional arguments, valid and malformed catalogue failures, uncharged domain checks and result refinements, including save/restore replay.

The `optional-args`, `optional-args-join` and `optional-args-fuel` cases cover trailing Optional Capability arguments: omission and explicit Nothing through a Library, immediate and fire-and-forget costs, Join members with different supplied counts, and rollback when an omitted-argument call cannot pay its declared Fuel.

The `suspension/wait-observation` case covers captured locals, live Script Variables in Guards, source-order branches, timeout ties, non-consuming observation and internal error messages before Handler dispatch. Go and TS agree byte for byte, including TS save/restore replay; its first blessing awaits human review. Four existing event-test Traces were corrected after paired execution, and four further expectations were corrected with maintainer approval from TS ordinary and save/restore agreement. This limited exception to the blessing rule does not establish Go parity; [#277](https://github.com/odogono/odgn-talk/issues/277) tracks the remaining verification. See the [charging reconciliation](../docs/reviews/event-test-charging/README.md) for the corrections and required Go facilities.

The `suspension/script-sends`, `suspension/send-preemption` and `limits/self-send-persistent` cases pin non-waiting sends to named Scripts and `me`, FIFO delivery, full/missing/invalid receiver errors, sender error survival, Trace record order and receiver identity retained across preemption without Value size, and same-Segment Persistent State checks after self-send. Go and TS ordinary execution agree byte for byte, as does TS save/restore replay. All three new cases await first human review. The corrected `suspension/wait-for` case also now agrees on Go, completing its ordinary-execution parity item in #277.

The reviewed `suspension/send-and-wait` case now also agrees on Go unchanged. Three new reply regressions agree on Go, TS ordinary execution and TS save/restore replay before blessing: `suspension/send-reply-preemption` pins a failed reply's unwind spending a Pump cap before catch instructions; `limits/send-wait-retention` counts the 48-byte pending call at suspension, while preserving the receiver after a sender fault; `suspension/send-wait-replacement` pins abandonment, cleanup and late replies when a sender is replaced. These cases retain their `Unblessed` headers for first human review. Paired execution exposed and corrected TS's omitted pending-call size at a Script send's suspension boundary.

Every blessed Trace Case runs in TS CI, including the limits at their conformance minimums and all Text Pattern seeds. Its Fuel, allocation and Persistent State figures are Cost Model 0's. New unblessed cases can be selected explicitly, and the Go passing gate protects the Text Pattern and error-delivery regressions above. Every available Core must agree before a case is blessed.

## The Disassembly Cases

The Session Transcripts under [`sessions/`](sessions/) were written by hand and blessed by `bun run corpus:run --bless`, which filled in their run ids and wrote their `case.trace` from the TS Session Host's. Each `case.trace` also passes as a Trace Case, in both replays. Each awaits its first human review in the [#131](https://github.com/odogono/odgn-talk/issues/131) PR that adds it.

The cases under [`disassembly/`](disassembly/) were written with the TS Core's lowering, and their expected `.dis` files were written by `bun run corpus:run --bless`, with the TS Core the only Core available ([chapter 11](../spec/11-the-trace-and-conformance.md#bless)). They await their first human review, as every case does, and the Go Core must agree before they count as blessed by both.

The 43 `scope-*` and `effect-*` cases under `capabilities/` cover scope slots, automatic cleanup, participant outcomes, cancellation cleanup, disablement, code changes and Save refusal. They pass TS normal and save/restore replay, plus replay using recorded Host results with Stub inputs removed. Their first human review is pending in #222. The [matrix reconciliation](capabilities/scoped-effects.md) identifies executable native Host tests and the unimplemented Message Layer transport coverage. Go parity remains unverified.
