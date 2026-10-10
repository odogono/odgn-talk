# The Conformance Corpus

The cases both Cores must pass, bit for bit ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)). Their formats are in [chapter 11](../spec/11-the-trace-and-conformance.md) of the Spec.

## Checking

Run these commands from the repository root. Both runners resolve relative case selectors under `corpus/`, not the shell's current directory; use `text-model/chunk-write-padding`, not `corpus/text-model/chunk-write-padding`. Absolute case directories also work.

| Runner | Entry point | Selection and gate |
| --- | --- | --- |
| TS | [`impl/ts/tools/corpus.ts`](../impl/ts/tools/corpus.ts), via `bun run corpus:run` | A named case or directory; `--list` reports support. With no selection it runs every case, blessed or not. |
| Go | [`impl/go/cmd/corpus/main.go`](../impl/go/cmd/corpus/main.go), run inside `impl/go` | Named case directories; `--list` reports support, and `--check-passing` runs every case and also enforces [`corpus-passing.txt`](../impl/go/corpus-passing.txt). |

For Go, after the [build/test prerequisites](../impl/go/README.md#build-and-test):

```sh
(cd impl/go && go run ./cmd/corpus text-model/chunk-write-padding)
(cd impl/go && go run ./cmd/corpus --check-passing)
```

CI runs both commands on every change, so both Cores run the complete Corpus in ordinary and save/restore replay. Each failure reports the case's first divergence, followed by a `reproduce:` line with the command that replays it.

Bless with [`tools/corpus/bless.ts`](../tools/corpus/bless.ts), which needs named cases and writes Disassembly, Trace or Transcript expectations, not encoding cases. The TS runner writes the expectations, then the TS and Go runners must each pass them in both replays. If either Core diverges, the case directory is restored and the divergence reported, as [chapter 11](../spec/11-the-trace-and-conformance.md#bless) requires. The TS runner's own `--bless` is the TS-only step it uses; the Go runner never writes expectations. Agreement is not first-blessing approval: follow the [seed review notes](#seed-blessing).

```sh
bun run corpus:check          # what CI runs: every case reads as chapter 11 says
bun run grammar:check         # every .talk file here parses
bun run machine:check         # and lowers
bun run corpus:run            # the TS Core runs every case
bun run corpus:bless text-model/chunk-write-padding # bless when TS and Go agree
bun run corpus:run text-model/chunk-write-padding   # replays a named case, blessed or not
```

### Adding a case

A new case passes CI only when all of these hold:

- **Unblessed header:** each expectation file (`case.trace`, and `session.transcript` for a Session case) starts with `# Unblessed: <what> (#issue); first blessing awaits human review.`; a Disassembly case carries it in `case.toml`. The reviewer removes it at first-blessing approval.
- **Ends with `> vars`:** a hand-written `case.trace` ends with `> vars` and a `vars` record per Script ([running a case](../spec/11-the-trace-and-conformance.md#running-a-case)); `corpus:check` rejects it otherwise.
- **Passes on Go:** `--check-passing` fails on every case Go cannot run, listed or not, so a case written against the TS Core alone fails the Go job. Add each case to [`corpus-passing.txt`](../impl/go/corpus-passing.txt) when the gate reports `NEW PASS`; Session Transcripts must be listed.
- **Blessed by agreement:** write expectations with `bun run corpus:bless <case> …`, not the TS runner's `--bless`.

Before pushing, run `bun run corpus:check` and `go -C impl/go run ./cmd/corpus --check-passing`.

[`tools/corpus/check.ts`](../tools/corpus/check.ts) reads each `case.toml` and `case.trace` against [`corpus.toml`](../spec/data/corpus.toml) and the display form. It doesn't run anything, so a case that passes it can still be wrong ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Case navigation

| Directory | What its cases pin |
| --- | --- |
| [`load-diagnostics/`](load-diagnostics/) | rejected loads: each step 1 diagnostic family and its source position ([chapter 2](../spec/02-grammar.md#load-time-diagnostics)); first blessings approved for #141 ([record](../docs/reviews/milestone-one-blessings/README.md)) |
| [`examples/`](examples/) | worked examples of the format, and the Trace Cases the Example Hosts record: `tenants-acme` and `tenants-globex`, from the [multi-tenant Go Host](../impl/go/examples/tenants/README.md), cover Grant bindings, `Charge` faults, per-plan limits, revocation and Reload (first blessings approved for #143, see the [approval record](../docs/reviews/tenants-blessings/README.md)) |
| [`save-restore/`](save-restore/) | save and restore: mid-Segment preemption, including inside a Join, pending-call settlements, cross-Script `send … and wait` pairs, variables-only restores, Grants and Libraries the Host no longer has, overdue `wait`s after a restore, and reissue Fuel charges, debt and cutoff ([chapter 10](../spec/10-save-and-restore.md)) |
| [`counters/`](counters/) | lifetime work and current state through preemption, faults, cleanup, Stop, code changes and both restore policies ([chapter 9](../spec/09-embedding.md#script-counters)) |
| [`limits/`](limits/) | exhaustion points, at dispatch too, Segment rollback, virtual-Clock deadlines, and each counted limit at its conformance minimum ([chapter 6](../spec/06-errors-and-limits.md)) |
| [`text-patterns/`](text-patterns/) | successive searches past empty matches, leftmost-first `or`, greedy defaults, matching Fuel, pattern size and repetition limits, and the canonical source of a pattern that starts with a group ([chapter 8](../spec/08-the-abstract-machine-and-the-cost-model.md#text-pattern-programs)) |
| [`bytes/`](bytes/) | building and matching Bytes with Binary Patterns, Bytes chunks and searches, build errors, and the Value Encoding of Bytes ([chapter 4](../spec/04-expressions-and-statements.md#binary-patterns)) |
| [`quantities/`](quantities/) | arithmetic and `as` through Base Units, `incompatible units`, and the Value Encoding of Quantities and ranges ([chapter 3](../spec/03-values.md#quantities)) |
| [`text-model/`](text-model/) | whole-Character boundaries, NFC at join seams and at the Host's text constructor, `word` and `word break` on punctuation, chunk padding on writes, out-of-range reads, and the `items` property on text, lists and integer ranges ([chapter 3](../spec/03-values.md), [chapter 4](../spec/04-expressions-and-statements.md#keys-and-properties)) |
| [`errors/`](errors/) | whole error maps, with their keys in order, queued error delivery, ahead of a `, queued` clause's parked Run, Handler dispatch and Guard skips, `during` bindings, and error backstops ([chapter 6](../spec/06-errors-and-limits.md#errors)) |
| [`dates/`](dates/) | Civil Date and Instant arithmetic, offsets, the date Built-ins and their errors, and the Value Encoding of dates ([chapter 3](../spec/03-values.md#dates-and-times)) |
| [`libraries/`](libraries/) | calls into Libraries, their defaults, Constants, Handlers and Function Values, errors and Limit Faults in Library code, adding Libraries to a Group, and direct/transitive `needs` with caller Grants and suspension ([chapter 7](../spec/07-libraries-and-the-standard-library.md#libraries)) |
| [`objects/`](objects/) | Host Objects: Deliveries routed by parents, `pass` and climbing, `the target`, sends to objects and up the Message Path, moving mailbox messages, object event filters and properties ([chapter 5](../spec/05-handlers-messages-and-scheduling.md#the-message-path)) |
| [`suspension/`](suspension/) | `wait`, `wait for` and its block form, Joins with their answers, failures and abandoned members, suspending Operations with their answers, failures and `maxPending`, `send … and wait` with its reply, `send failed` and `MaxWait`, waits inside called Handlers and Lambdas, and Persistent State at a suspension, and Timeout Block deadlines around Joins and single waits, nested, tied and already past, with first-blessing review pending in the [review record](../docs/reviews/timeout-block/README.md) ([chapter 5](../spec/05-handlers-messages-and-scheduling.md#suspension-points)) |
| [`capabilities/`](capabilities/) | immediate and fire-and-forget Capability calls through Grants, Stubs and `Charge`, argument Shapes and trailing Optional arguments, Host failures and `host error`, the load checks of `ask`, `tell` and `say`, Grant trimming with Library needs, revocation during a pending call, all six Standard Capabilities and the optional `sqlite`, with its conversions, row charges and `transaction` scope (`standard-sqlite*`, first blessings pending in the [review record](../docs/reviews/sqlite-blessings/README.md) for #467), the optional `user` with its answers, cancels, timeouts, `user busy` and checked `choose` answers (`standard-user*`, Unblessed until first-blessing review for #527), faults at a call, and Grants sharing a Segment Coordinator (`effect-coordinator-*`, first blessings approved for #459, see the [approval record](../docs/reviews/segment-coordinator-blessings/README.md)) ([chapter 9](../spec/09-embedding.md#capabilities)) |
| [`store-kit/`](store-kit/) | not Trace Cases: the store test kit, Operation and lifecycle sequences that every `store` implementation must follow ([chapter 7](../spec/07-libraries-and-the-standard-library.md#store)) |
| [`sqlite-kit/`](sqlite-kit/) | not Trace Cases: the sqlite test kit, statement and lifecycle sequences that every `sqlite` implementation must follow against a real database, a co-located Store's included ([chapter 9](../spec/09-embedding.md#sqlite-host-obligations)) |
| [`stdlib/`](stdlib/) | calls into the stdlib Libraries with no `add-library` line, and errors raised in stdlib code naming the Script's call ([chapter 7](../spec/07-libraries-and-the-standard-library.md#the-standard-library), [ADR 0037](../docs/adr/0037-errors-raised-in-stdlib-code-point-at-the-scripts-call.md)) |
| [`math/`](math/) | the correctly rounded number functions and fractional `^`, the Float Built-ins, and their domain errors ([chapter 7](../spec/07-libraries-and-the-standard-library.md#numbers)) |
| [`functions/`](functions/) | Host and foreign Function Value calls, defaults, Capability callbacks, replies, staleness and cancellation ([chapters 5](../spec/05-handlers-messages-and-scheduling.md#function-values-in-another-script) and [9](../spec/09-embedding.md#function-values)) |
| [`collecting/`](collecting/) | Collecting Clause initialization, filtering, early exit, partial lists after errors, conditions and waiting bodies ([ADR 0059](../docs/adr/0059-a-repeat-may-collect-its-results.md)); Go/TS ordinary and save/restore agreement, [evidence](../docs/reviews/collecting/README.md); first blessings approved on 2026-10-07 ([approval record](../docs/reviews/milestone-one-blessings/README.md)) |
| [`computed-sends/`](computed-sends/) | `send (e)` with a computed Name or Selector, waiting and in a Join, forwarding `wait for`'s `it`, climbing to `unhandled`, and `wrong kind` and `bad message name` checked before the receiver ([chapter 5](../spec/05-handlers-messages-and-scheduling.md#sending), [ADR 0057](../docs/adr/0057-a-send-may-compute-its-message-name.md)); first blessings approved, see the [approval record](../docs/reviews/computed-send-blessings/README.md) |
| [`rewind/`](rewind/) | Rewinding a Run in its first Segment: at a Host crossing and at a drain, on preempted and parked Runs, for climbed, `error`, Request, Decision and Function Value messages, Segment-bound rollback and repeated final effects, `not-rewindable` notes, and a Reload that keeps the mailbox ([chapter 9](../spec/09-embedding.md#threads-and-the-input-queue), [ADR 0068](../docs/adr/0068-a-run-in-its-first-segment-can-be-rewound-to-its-delivery.md)); first blessings approved for #433, see the [approval record](../docs/reviews/rewind-blessings/README.md) |
| [`fallback/`](fallback/) | the Fallback Handler: messages no clause matches, its reply, `pass any message` up the Message Path, Queueing Policies, forwarding with a spread in `send … with`, and the Broadcasts, Decisions and `error` messages it never takes ([chapter 5](../spec/05-handlers-messages-and-scheduling.md#the-fallback-handler), [ADR 0064](../docs/adr/0064-a-fallback-handler-receives-messages-no-clause-matches.md)); first blessings approved by the maintainer on 2026-10-07 for #333 |
| [`tell-block/`](tell-block/) | `tell` blocks: the one-line calls each line stands for, with the same calls, Fuel and Persistent State, `it` between lines, a failing line raised at its Operation name, waiting lines as Join Members, mode and Grant checks at the Operation name, and a Library's lines rechecked against an importer's Grants ([ADR 0063](../docs/adr/0063-a-tell-block-calls-several-operations-of-one-grant.md)); Go/TS ordinary and save/restore agreement, with first-blessing review pending in the [review record](../docs/reviews/tell-block/README.md) |
| [`whose/`](whose/) | Whose Clauses over lists of maps and text chunks, no match, the ordinal and `last` forms, stopping at the n-th match, non-boolean conditions, Whose Keys beside locals of the same name, and `not in a whose` ([ADR 0074](../docs/adr/0074-a-whose-clause-picks-the-chunks-whose-condition-holds.md)); Go/TS ordinary and save/restore agreement; first blessings await review (#547) |
| [`decisions/`](decisions/) | Decisions: first-Segment seals across preemption, veto and pass, dispatch and pending waits, undecided errors and faults, and Broadcast recipient aggregation ([ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md)) |
| [`cancellation/`](cancellation/) | Broadcast recipients, Queueing Policies, cancelled cleanup and its failures, Host crossings, owner disposal and sticky Stop ([chapters 5 and 6](../spec/06-errors-and-limits.md#cancellation-and-stop)) |
| [`reload/`](reload/) | Reload carry/reset and discarded Runs, extension code units and their state cap, transitive Library replacement, and stale Function Values ([chapter 10](../spec/10-save-and-restore.md#reload-and-extend)) |
| [`builtins/`](builtins/) | reading a value's kind with `kindOf`, and a Function Value's arity and name with `functionArity` and `functionName`, stale ones included, and a Host Object's Object Kind with `objectKind`, disposed ones included ([chapter 7](../spec/07-libraries-and-the-standard-library.md#values), [ADR 0043](../docs/adr/0043-values-are-introspected-through-built-in-functions.md), [ADR 0044](../docs/adr/0044-a-host-objects-object-kind-is-read-with-a-built-in.md)) |
| [`disassembly/`](disassembly/) | Disassembly Cases: the lowering of expressions, Containers, Destructuring, control flow and `try`, calls and Lambdas, messages and waiting, `tell` blocks and Timeout Blocks, which between them emit every instruction ([chapter 8](../spec/08-the-abstract-machine-and-the-cost-model.md#the-lowering)) |
| [`sessions/`](sessions/) | Session Transcripts: Entries, echoes and `say`, implicit Script Variables, declarations and redefinitions, rejected Entries, background lines, a real Clock's `@` readings, deadline Pumps and `read` answers, mock Operations with their Stubs, answers and failures, Store Grant bindings and aliases across `:save`/`:restore` (`store-bindings`, awaiting first-blessing review for #538), `user` prompts with an answer, a cancel, a timeout, `user busy` and `notify` (`user-prompts`, awaiting first-blessing review for #527), a virtual Clock, redefinition while a Run is suspended, `:cancel`, `:runs`, `:mailbox`, `:vars`, `:limits`, `:save` and `:restore` with an adopted call, user Libraries and `:export`, `:trace`/`:untrace` rows and `:fuel` measurements (`observation`, Unblessed until its first blessing is reviewed for #438), `:describe` and `:apropos` (`describe` and `apropos`, awaiting first-blessing review for #437), `:inspect` and `%` object/Function crossing replay (`object-inspection`, [review pending](../docs/reviews/object-inspection/README.md) for #439), and refused Session Commands ([chapter 12](../spec/12-sessions-and-tooling.md#session-transcripts)) |

The `text-model/items-property` case (#565) pins list reads, text
splitting, integer-range materialization and `wrong kind` fields for unsupported
subjects. Go and TS agree in ordinary and save/restore replay, and Go requires
it in its passing gate. Its first human blessing remains pending; current
support is described in the [Go machine guide](../impl/go/README.md#machine-execution).

The `cancellation/refused-host-crossings` case pins property and Capability
refusals after their crossing records, including repeated getters after a
between-Pump restore and cancellation/refusal ordering (#492). Both Cores replay
it in both modes; its first blessing awaits human review. The two parent-cycle
refusals in `sessions/object-inspection/case.trace` use the same corrected order;
that case's first blessing remains pending for #485.

The [`cancellation/failed-operation-crossings`](cancellation/failed-operation-crossings/)
case pins Host failures at Operation crossings interrupted by cancellation and
Stop (#540): the `call` error record remains, with no `host error` raise or
`call-failed` report. Both Cores agree in ordinary and Save/Restore replay, and
Go requires it in its passing gate; first-blessing approval awaits human review.

The `reload/decomposed-source` and `sessions/decomposed-source` cases
preserve source scalars and Code identities through Extend, Reload, Library
replacement and Session inspection, while runtime Text Values remain NFC
(#456). Both Cores replay them in both modes; their three expectation files
received human first-blessing approval on 2026-10-09
([approval and evidence](../docs/reviews/trace-source/README.md)).

## Seed blessing

The `sessions/named-functions` case (#450) pins named Function Values from
Extend units in expression echoes, `:describe` value rows and final `vars`.
Both Cores agree on the Transcript and on independent ordinary and save/restore
Trace replay. The case covers live and stale values through explicit Save and
Restore, unequal old/new definitions with the same display, and a renamed
Library import added by Extend. The runtime display correction landed in #462;
chapters 3 and 11 now state the rule explicitly. Both expectation files retain
their `Unblessed` markers pending first-blessing review.

The original 198 seed cases execute on the TS Core, which supplied their first blessings. Every seed's first blessing has had its human review, the last being the five seeds whose headers derive their figures from Cost Model 0 (`fuel-alloc-minimums`, `persistent-state-minimum`, `matching-fuel-exhaustion`, `canonical-source-leading-group` and `replace-all-empty-matches`), reviewed in [#126](https://github.com/odogono/odgn-talk/issues/126). The four Value Encoding cases' hand-written bytes are reproduced exactly by the TS Core and were reviewed with them. The Go Core now replays its supported subset through its public embedding API; see its [passing gate](../impl/go/README.md#corpus-runner).

The corrected `capabilities/scope-slots` and `scope-suspension-boundaries`
Traces agree on Go and TS, including TS save/restore replay. Rejected scope
calls and suspension boundaries consume no guarded instruction Fuel or
allocation, while dispatch and unwind still apply. They are required by the Go
passing gate. The related `effect-participant-conflict` correction now agrees
on Go ordinary execution and TS ordinary/save-restore execution. Go supports
Segment-bound Operations following #340. The maintainer approved the first
blessings of seven limit/cancellation regressions and 22 effect cases on
2026-10-05 for #135 and #326; see the
[approval record](../docs/reviews/go-step-four-blessings/README.md). The other scope and
effect cases were approved for #141 ([approval record](../docs/reviews/milestone-one-blessings/README.md)). For current Save and
Library replacement support, see the [Go lifecycle guide](../impl/go/README.md#save-restore-and-code-updates). See the
[boundary audit and expectation diff](../docs/reviews/scope-guard-charging/README.md).

The three new Text Pattern regression cases (`counted-program-sizes`, `empty-literal-composition` and `splice-wrong-kind`) pin chapter 8's program sizes, chapter 11's empty-group canonical source and chapter 4's wrong-kind splice fields. Both Cores reproduce their complete Traces. The maintainer approved their first blessings on 2026-10-07; see the [approval record](../docs/reviews/milestone-one-blessings/README.md). No existing expectation was re-blessed for these fixes.

The corrected `decisions/undecided-on-cancel-delivery` seed agrees on Go and TS
through public cancellation contexts/signals. Its post-seal cancellation queues
no input under chapter 9, so that line is removed from the canonical Trace and
injected by native replay tests instead. All output records and costs are
unchanged. The maintainer approved the correction on 2026-10-05; see the
[step-3 approval record](../docs/reviews/step-three-blessings/README.md) and the
[reconciliation](../docs/reviews/delivery-cancellation/README.md).

The fenced-text regression cases `load-diagnostics/invalid-text-closing-margin`,
`load-diagnostics/invalid-raw-text-closing-margin` and `limits/fenced-text-concat`
pin the first offending scalar in a raw or
backtick closing margin, generated joins' `${` source position, exact Fuel and
allocation exhaustion, and Segment rollback. Both Cores reproduce their complete
Traces, including TS save/restore replay. The maintainer approved
`limits/fenced-text-concat` for #135 on 2026-10-05; the two load diagnostics
were approved for #275 on 2026-10-05; see the
[fenced-text approval record](../docs/reviews/fenced-text-blessings/README.md).

The `stdlib/template-migration` regression pins `${…}` placeholders and `$$`
in the normative text/date Libraries. It covers literal braces, keys with spaces
and punctuation, values inserted once, NFC joins, date widths and fractional
seconds, and invalid templates' error fields and caller positions. Go and TS
reproduce its complete Trace, including TS save/restore replay. Its
expectations were approved for #275 on 2026-10-05, along with the corrected
`sessions/fenced-text` Transcript and its Trace. The Transcript
prints its margin-stripped multiline value, preserving a blank line and a
multiline hole; it also executes interpolation and a raw Format Template.
Session Transcripts run unchanged on both Cores. The Go runner compares their
recorded output and Trace, then replays that Trace independently through the
public embedding API, ordinarily and with Save/Restore between Pumps.

The two new error-delivery regression cases (`handler-delivery` and
`handler-backstop`) pin chapter 6's separate error Runs, FIFO order, `during`
bindings before Guards, unmatched-message handling and prevention of recursive
error delivery. They also pin chapter 8's dispatch costs, retained mailbox state
and Fuel Slice preemption. Both Cores agree on their complete Traces; the
maintainer approved their first blessings on 2026-10-05; see the
[step-3 approval record](../docs/reviews/step-three-blessings/README.md).

The seed cases were written before any Core existed. Until a case is blessed, its `case.trace` has its `>` Host Input lines and its Core output lines written by hand, and says so in its header:

```text
# Unblessed: the output lines are written by hand, not by bless.
```

- **What a case pins** (its records, their order, its ids, values, error codes, instructions and source positions) is worked out from the Spec, and is what a Core is checked against.
- **Fuel, allocation and Persistent State figures** are estimates, except where a case says in a comment that it pins one and shows how it is worked out from Cost Model 0.
- **Code identities** are left out of `load` and `add-library` lines, which an author may do, and bless fills them in.
- **Instruction indices** in `at=` come from `bun tools/machine/check.ts --dis <file>`, which isn't normative. Blessing checks them against a Core.

A human reviews each case's diff when it is first blessed, and a case whose hand-written lines turn out to be wrong is fixed then, with a Spec fix if the Spec was unclear.

The three `counters/` cases pin lifetime work, mailbox and live state, fault rollback, failed cleanup, Reload/Extend and full or variables-only restore. All three agree on Go and TS ordinary/save-restore replay and are protected by the Go passing gate. The corrected `faults-and-cleanup` case cancels a Request through its public context/signal, keeping every output and counter unchanged. The maintainer approved the correction on 2026-10-07 ([approval record](../docs/reviews/milestone-one-blessings/README.md)); see the [Spec derivation](../docs/reviews/delivery-cancellation/README.md#queued-request-cancellation-correction-364).

The `event-test-slice-debt` and `event-test-group-cap` cases in `suspension/` pin observation Fuel, atomic waiter checks, dispatch ordering and slice debt. The `event-tests-fault-on-resume` case in `limits/` pins uncapped observation charges and the waiting Run's fault at its next resumed instruction. All three pass full and save/restore replay.

The `moving-mailbox`, `moving-climb` and `wait-target` cases in `objects/` pin transfer admission and ordering, queued path continuation, fixed Targets and object-filtered event observation. Go supports registered handles, well-known bindings and queued disposal; the reviewed `builtins/object-kind` and `builtins/kind-of` traces pass unchanged in both Cores and are required by the Go passing gate. The corrected `objects/properties` trace uses a local alias for its runtime read-only write, adding two Fuel and shifting later source/instruction positions. New `load-diagnostics/object-properties` and `objects/guard-keys` cases cover declaration-aware Load refusals and pure dynamic Guard reads, including disposed Objects and Core ids. Both Cores agree on these three traces and all are required by the Go passing gate. The maintainer approved their first blessings on 2026-10-05 and a later `objects/properties` correction on 2026-10-07; see the [step-3 approval record](../docs/reviews/step-three-blessings/README.md). Current routing support is described in the [Go Object Message Paths guide](../impl/go/README.md#object-message-paths).

The four `functions/` cases cover Host and foreign calls, cancellation, defaults and previously exported callbacks returned through Capability Stubs and answers.

The two `needs-*` cases in `libraries/` cover missing transitive Grants and suspension through a Library frame.

The `grants-as-used`, `revoke-in-flight` and `revoke-reissue` cases in `capabilities/` cover trimming, code-change checks and revocation without abandoning a pending call, including save/restore replay and explicit Reissue.

The `standard-store` cases pin the Core's side of `store` ([#226](https://github.com/odogono/odgn-talk/issues/226)): all six Operations through Stubs and `stub-effect` lines, `invalid key` before charging, Shape and result checks, declared Store failures and their catalogue fields, a read-only Grant that never enlists, and rollback at a Limit Fault. The TS Core produced their expectations, and the maintainer approved their first blessings on 2026-10-07; see the [approval record](../docs/reviews/store-blessings/README.md). For [#461](https://github.com/odogono/odgn-talk/issues/461), every Store shares one Segment Coordinator, so in `standard-store-segments` a second Store's write joins the participant instead of raising `segment participant conflict`; that change, and the new `standard-store-coordinator` case for the "Two Stores in one Segment" worked example, are Unblessed until reviewed. Go reproduces all five traces in ordinary and Save/Restore replay, and requires them in its passing gate. Current support and limitations are described in the [TS Group and Trace Cases guide](../impl/ts/README.md#the-group-and-trace-cases) and the [Go Store guide](../impl/go/README.md#store-standard-capability).

The `standard-clock`, `standard-timer` and `standard-clock-fuel` cases use fixed Standard Capability declarations. They cover nanosecond-accurate Pump readings without Stubs, Host timer calls and ordinary Deliveries, Library needs, and rollback when a call's declared cost exhausts Fuel. Go and TS reproduce all three reviewed traces unchanged; Go protects them with a required-case acceptance test and its passing gate.

The `standard-console`, `standard-console-cancel` and `standard-console-timeout`
cases cover Console calls through fixed declarations: a Library's `say` of
nested Function Values, an empty input line, extra starting and late Fuel,
cancellation and late answers, and the human-input deadline overriding a shorter
Script `MaxWait`. Go and TS reproduce all three reviewed traces unchanged.
Go also reproduces `reload/function-staleness` with Function Values displayed by
source position. All four cases are protected in Go's required-case acceptance
test and gate.

The `standard-locale`, `standard-locale-ranks` and `standard-locale-validation` cases cover all eight Locale Operations, Host data and fallback, stable sorting through dense ranks, malformed answers, option and tag checks, and save/restore replay. Go and TS reproduce all three reviewed traces unchanged; Go protects them with a required-case acceptance test and its passing gate.

The `standard-calendar`, `standard-calendar-errors` and `standard-calendar-validation` cases cover the six fixed Calendar Operations, optional arguments, valid and malformed catalogue failures, uncharged domain checks and result refinements, including save/restore replay. Go and TS reproduce all three reviewed traces unchanged; Go protects them with a required-case acceptance test and its passing gate.

The `optional-args`, `optional-args-join` and `optional-args-fuel` cases cover trailing Optional Capability arguments: omission and explicit Nothing through a Library, immediate and fire-and-forget costs, Join members with different supplied counts, and rollback when an omitted-argument call cannot pay its declared Fuel.

The `suspension/wait-observation` case covers captured locals, live Script Variables in Guards, source-order branches, timeout ties, non-consuming observation and internal error messages before Handler dispatch. All eight corrected event-test Traces and this regression agree byte for byte on Go and TS in ordinary and save/restore replay, including `reload/extend-units`. The maintainer approved the regression's first blessing on 2026-10-05; see the [step-3 approval record](../docs/reviews/step-three-blessings/README.md). Four corrections originally received maintainer approval from TS-only agreement; the [charging reconciliation](../docs/reviews/event-test-charging/README.md) records that limited exception and the subsequent complete Go verification for [#277](https://github.com/odogono/odgn-talk/issues/277).

The `suspension/script-sends`, `suspension/send-preemption` and `limits/self-send-persistent` cases pin non-waiting sends to named Scripts and `me`, FIFO delivery, full/missing/invalid receiver errors, sender error survival, Trace record order and receiver identity retained across preemption without Value size, and same-Segment Persistent State checks after self-send. Go and TS ordinary execution agree byte for byte, as does TS save/restore replay. `limits/self-send-persistent` was approved for #135 on 2026-10-05; the maintainer approved the two suspension cases' first blessings on 2026-10-05 and a later `suspension/script-sends` correction on 2026-10-07; see the [step-3 approval record](../docs/reviews/step-three-blessings/README.md). The corrected `suspension/wait-for` case also now agrees on Go, completing its ordinary-execution parity item in #277.

The reviewed `suspension/send-and-wait` case now also agrees on Go unchanged. Three new reply regressions agree on Go, TS ordinary execution and TS save/restore replay before blessing: `suspension/send-reply-preemption` pins a failed reply's unwind spending a Pump cap before catch instructions; `limits/send-wait-retention` counts the 48-byte pending call at suspension, while preserving the receiver after a sender fault; `suspension/send-wait-replacement` pins abandonment, cleanup and late replies when a sender is replaced. `limits/send-wait-retention` was approved for #135 on 2026-10-05; the maintainer approved the two suspension cases' first blessings on 2026-10-05 and a later `suspension/send-reply-preemption` correction on 2026-10-07; see the [step-3 approval record](../docs/reviews/step-three-blessings/README.md). Paired execution exposed and corrected TS's omitted pending-call size at a Script send's suspension boundary.

The Script-only Join cases `suspension/script-joins`, `suspension/join-preemption`,
`limits/join-retention` and `limits/script-join-width` agree on actual Go, TS ordinary
execution and TS save/restore before blessing. They cover ordered and empty dynamic
results, fail-fast abandonment with surviving receivers, queued self-sends, replies
retained across open-body preemption, pending state at suspension, tightened width
limits and body-error abandonment before a later unwind fault. The paired
`load-diagnostics/missing-handler-wait` case rejects a plain local Handler call
that could conceal an indirect nested Join. `limits/join-retention` and
`limits/script-join-width` were approved for #135 on 2026-10-05. The maintainer
approved the first blessings of the two suspension cases and the load diagnostic
on 2026-10-05 and a later `suspension/script-joins` correction on 2026-10-07; see
the [step-3 approval record](../docs/reviews/step-three-blessings/README.md). The mixed-Capability `suspension/joins` case also
agrees on ordinary Go execution.

Six reviewed ordinary Capability cases now pass unchanged on Go: `calls`,
`argument-shapes`, `load-checks`, `host-failures`, `charge-faults` and
`optional-args-fuel`. The new `declared-allocation` and `ordinary-grants` cases
agree on Go, TS ordinary execution and TS save/restore before blessing. They pin
atomic declared costs, Optional arguments, alias Grants, revocation, trimming and
caught raises before later Host calls. The maintainer approved their first
blessings on 2026-10-05 and a later `ordinary-grants` correction on 2026-10-07;
see the [step-3 approval record](../docs/reviews/step-three-blessings/README.md). Library needs are now checked and retained when trimming Grants;
Standard Capability factories remain separate Go work.

Reviewed `suspension/answers`, mixed `suspension/joins`, `optional-args-join`,
`revoke-in-flight` and the `max-wait-minimum`/`max-join-minimum` cases now pass
unchanged on Go. The new `suspension/capability-resumption` regression agrees on
Go, TS ordinary execution and TS save/restore. It covers early answers across Join
body preemption, conversion/late Fuel under a Pump cap, fail-fast input ordering,
late-cost faults preserving earlier Segments, Run cancellation and Reload
abandonment. The maintainer approved its first blessing on 2026-10-05 and a
later correction on 2026-10-07; see the
[step-3 approval record](../docs/reviews/step-three-blessings/README.md). The reviewed
`reload/reload-carry-and-discard` case also passes unchanged; current Go
lifecycle support is described in the [Go guide](../impl/go/README.md#save-restore-and-code-updates).

The `suspension/join-closing-position` regression pins failed replies and timeouts
at a Join's closing `end`, including bare `end`, `end wait` and a local Handler.
Go, TS ordinary execution and TS save/restore agree on its complete Trace;
the maintainer reviewed its first blessing in #286. The corrected `suspension/script-joins`,
`limits/join-retention` and `disassembly/messages-and-waiting` expectations also
agree on both Cores, with only source positions changed. See the
[Join source-position reconciliation](../docs/reviews/join-source-positions/README.md)
for the maintainer-approved mixed-Capability `suspension/joins` correction
and its historical Lambda parity findings. `errors/lambda-capture-parity` now
agrees on Go, TS ordinary execution and TS save/restore: nested Lambda errors
name the enclosing Handler, Join failures/timeouts retain the closing token,
and captured Values have the specified allocation and retained sizes. The
maintainer approved its first blessing on 2026-10-05 and a later correction on
2026-10-07; see the [step-3 approval record](../docs/reviews/step-three-blessings/README.md).

Every blessed Trace Case runs in TS CI, including the limits at their conformance minimums and all Text Pattern seeds. Its Fuel, allocation and Persistent State figures are Cost Model 0's. New unblessed cases can be selected explicitly, and the Go passing gate protects the Text Pattern and error-delivery regressions above. Every available Core must agree before a case is blessed.

The `suspension/argument-labels`, `objects/argument-labels` and
`load-diagnostics/argument-labels` cases pin labelled Clauses and calls,
target-first sends and replies, Message Path passes, event observation and `it`,
selector-aware faults in nested Lambdas, Host Selector refusals, suspension
checks and chunk/Unit traps. Go and TS agree on their complete ordinary and
save/restore Traces. The `sessions/argument-labels` Transcript agrees on both
Cores and covers Entry recognition and positional/labelled Handlers sharing a first word. Their
first blessings were approved on 2026-10-07; see the [approval record](../docs/reviews/milestone-one-blessings/README.md).

The `objects/queued-parent-refusals` case (#457) pins drain-time `parent cycle` and `invalid value` refusals, unchanged parents, subsequent routing and final Script Variables. TS and Go agree in ordinary and save/restore replay. The maintainer approved its `case.trace` first blessing on 2026-10-08 in the #457 implementation thread. Direct API tests in both Cores additionally cover a parent change saved while queued whose child becomes unresolved at Restore; the Trace case does not claim that explicit Save boundary.

## The Disassembly Cases

The Session Transcripts under [`sessions/`](sessions/) were written by hand and blessed by `bun run corpus:run --bless`, which filled in their run ids and wrote their `case.trace` from the TS Session Host's. Each `case.trace` also passes as a Trace Case on both Cores, ordinarily and with Save/Restore between Pumps. The original nine first blessings were reviewed in their PRs, as recorded in [#131](https://github.com/odogono/odgn-talk/issues/131#issuecomment-5957819419). The later `fenced-text` Transcript was approved on 2026-10-05; see the [fenced-text approval record](../docs/reviews/fenced-text-blessings/README.md). The `describe` and `apropos` Transcripts ([#437](https://github.com/odogono/odgn-talk/issues/437)) await first-blessing review.

The cases under [`disassembly/`](disassembly/) were written with the TS Core's lowering, and their expected `.dis` files were written by `bun run corpus:run --bless`, with the TS Core the only Core available ([chapter 11](../spec/11-the-trace-and-conformance.md#bless)). Both Cores agree on every `.dis` file, and every Disassembly Case's first blessing is approved; the earlier ones for #141 ([approval record](../docs/reviews/milestone-one-blessings/README.md)).

The 43 `scope-*` and `effect-*` cases under `capabilities/` cover scope slots, automatic cleanup, participant outcomes, cancellation cleanup, disablement, code changes and Save refusal. They pass TS normal and save/restore replay, plus replay using recorded Host results with Stub inputs removed. Both Cores agree on all of them in both replays, and their first blessings are approved (#135, #141). The [matrix reconciliation](capabilities/scoped-effects.md) identifies executable native Host tests and the unimplemented Message Layer transport coverage.

The Go ordinary Library slice also passes the reviewed `libraries/calls`,
`libraries/errors`, `libraries/registration`, `stdlib/calls`,
`stdlib/errors-name-the-call` and `builtins/function-values` cases unchanged.
These pin transitive imports, defaults, shared Function code, source-ordered
Handler clauses, registration refusals, Library errors/faults and caller-facing
Standard Library errors. Go now also passes `libraries/needs-transitive`, `libraries/needs-suspending` and
`capabilities/optional-args` unchanged, with import-time needs checks, Grant
trimming and Capability execution through caller-owned Library frames.

The new `libraries/caller-capabilities` regression agrees on Go, TS ordinary
execution and TS save/restore. It pins private/transitive needs, nested Library
frame suspension and charges, cancellation cleanup, late answers and revocation.
The maintainer approved its first blessing on 2026-10-05 and a later correction
on 2026-10-07; see the [step-3 approval record](../docs/reviews/step-three-blessings/README.md).
Standard Capability factories, Host Objects and full lifecycle remain separate Go work.

## Non-Script suspension retention audit

The eight #281 cases named in the [review record](../docs/reviews/suspension-retention/README.md)
agree on actual Go and TS execution, including both save/restore replays. They
pin the one-byte-below and exact Persistent State boundaries for suspending
Operations, foreign Function Value calls, one-line and block event captures
and object filters, pending Join members and early answers. The maintainer
approved their first blessings on 2026-10-07; see the [approval record](../docs/reviews/milestone-one-blessings/README.md).
Current behavior is described in the [TS verification guide](../impl/ts/README.md#verification-and-corpus-selection).

The Recovery Offers cases `basic`, `boundaries`, `costs`, `cleanup-restore`,
`nested`, `cancellation` and `action-suspend`, plus `disassembly/recovery-offers`,
cover retained Library work, choice/entry ordering, foreign-Run boundaries,
exact dispatch sizes, atomic lookup debt, nested policy, cancellation and action
suspension. Both Cores execute ordinary and restored replay, and the Go passing
gate protects them. The maintainer approved their first blessings and the
corrections to existing catch expectations on 2026-10-07 at `0c3c33f`; see the
[final review package](../docs/reviews/recovery-offers-integration/README.md).
Current language rules are in [chapter 4](../spec/04-expressions-and-statements.md#recovery-offers);
Core/tooling guides describe support, while the slice review notes record
historical evidence.
