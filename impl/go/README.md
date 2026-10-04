# Go Core

The Go Core is module `github.com/odogono/odgn-talk/impl/go`, with public root
package `northtalk`. It provides immutable values, decimal arithmetic, pinned
Unicode text, a front end and standalone Abstract Machine execution. Its Group
embedding subset loads Scripts, accepts Deliveries and Requests, pumps Runs and
emits canonical Trace records. The Spec, Data Files and Conformance Corpus are
the authority; the TS Core is not a reference
([ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

## Task navigation

| Task | Implementation | Rules | Tests and cases |
| --- | --- | --- | --- |
| Lexing and parsing | [syntax](internal/syntax/) | [lexical structure](../../spec/01-lexical-structure.md), [grammar](../../spec/02-grammar.md) | [lexer tests](internal/syntax/lexer_test.go), [parser tests](internal/syntax/parser_test.go) |
| Name and binding checks | [checker](internal/check/check.go) | [load diagnostics](../../spec/02-grammar.md#load-time-diagnostics) | [checker tests](internal/check/check_test.go), [load diagnostics](../../corpus/load-diagnostics/) |
| Lowering and source maps | [lowering](internal/lower/) | [Abstract Machine](../../spec/08-the-abstract-machine-and-the-cost-model.md) | [lowering tests](internal/lower/lower_test.go), [disassembly cases](../../corpus/disassembly/) |
| Execution and resource costs | [machine](internal/machine/) | [Abstract Machine and costs](../../spec/08-the-abstract-machine-and-the-cost-model.md), [limits](../../spec/06-errors-and-limits.md) | [machine tests](internal/machine/machine_test.go), [execution tests](execution_test.go), [limit cases](../../corpus/limits/) |
| Dispatch, scheduling and waits | [Host inputs](group.go), [Run scheduling](group_run.go), [message observation](group_observe.go), [sends](group_send.go) | [scheduling](../../spec/05-handlers-messages-and-scheduling.md), [embedding](../../spec/09-embedding.md) | [error delivery](error_delivery_test.go), [waits](wait_test.go), [message waits](wait_for_test.go), [sends](send_wait_test.go) |
| Capability Operations | [definitions and Grants](capability.go), [Shapes](shape.go), [load checks](internal/check/operations.go), [Host crossings](group_operation.go) | [Capabilities and Shapes](../../spec/09-embedding.md#capabilities), [costs](../../spec/08-the-abstract-machine-and-the-cost-model.md) | [embedding tests](capability_test.go), [Capability cases](../../corpus/capabilities/) |
| Text Patterns | [lowering](internal/lower/pattern.go), [values](internal/value/pattern.go), [Pike VM](internal/machine/pattern.go) | [Text Pattern programs](../../spec/08-the-abstract-machine-and-the-cost-model.md#text-pattern-programs) | [public acceptance](pattern_test.go), [VM tests](internal/machine/pattern_test.go), [pattern cases](../../corpus/text-patterns/) |
| Generated tables | [Go generator](../../tools/go/generate.ts), [Unicode generator](../../tools/unicode/generate.ts), [syntax generator](../../tools/syntax/generate.ts) → [tables](internal/generated/) | [Data Files](../../spec/README.md#data-files) | [generator tests](../../tools/go/generate.test.ts), [Unicode tests](internal/unicode/unicode_test.go) |
| Corpus selection and parity | [CLI](cmd/corpus/main.go), [runner](internal/corpus/runner.go), [passing gate](corpus-passing.txt) | [corpus commands and blessing](../../corpus/README.md#checking), [conformance](../../spec/11-the-trace-and-conformance.md) | [runner tests](internal/corpus/corpus_test.go), [execution backends](internal/corpus/execution_test.go) |

The feature sections below describe the supported subset and its limits. Follow Spec links for rules and the [ADR index](../../docs/adr/README.md) for rationale. The TS Core is a parity peer; root `tools/grammar/` and `tools/machine/` are Spec-checking prototypes. Update generated files through their generators.

## Layout

- The root package implements the available declarations of the
  [embedding interface](../../spec/embedding/talk.go). `value.go`, `encoding.go`
  and `text.go` own immutable values and codecs. `core.go` owns compilation and
  default limits; `group.go` owns Host inputs, and `group_run.go` pumps Runs.
- `internal/generated/` holds tables from Spec Data Files and pinned Unicode
  sources, with `UNICODE-LICENSE.txt` beside them.
- `internal/unicode/` supplies NFC, Character boundaries, simple folding, full
  default case mappings and White_Space-based words. Spans use zero-based UTF-8
  byte offsets; Script source positions count scalars from line and column 1.
- `internal/decimal/` supplies exact-input decimals, arithmetic, integral
  rounding and elementary functions. Outward-rounded intervals increase
  precision until both bounds select the same 34-digit half-even result.
- `internal/value/` owns values, Units, comparison, display and strict JSON.
  Containers copy input slices; public accessors return copies.
- `internal/syntax/` owns lossless UTF-8 lexing and parsing. `Tree.Source()`
  reconstructs every source byte; only Text literal values are NFC.
- `internal/check/` resolves declarations, body slots, captures and initializer
  dependencies. Diagnostics sort by source position, then catalogue order.
- `internal/lower/` produces canonical instructions, source maps, Unwind Tables
  and Event Tables. Labels use instruction indices, never byte offsets. Its
  Go-private byte encoding round-trips each body's instruction stream.
- `internal/machine/` executes checked code with heap frames, detached operand
  evaluation, clause dispatch, unwind state and generated Cost Model 0 charges.
- `internal/trace/` orders records and keys by `corpus.toml`. It removes the
  Core's non-parity error wording from Trace values, including nested errors,
  while preserving Script and Host data named `message`.
- `internal/corpus/` reads setups and runs encoding, disassembly and Trace
  backends. `cmd/corpus/` provides selection, first-divergence output and the gate.
- `internal/apicheck/` compares root exports and signatures with `talk.go`,
  including promoted members. Missing declarations are reported without failing
  until [#141](https://github.com/odogono/odgn-talk/issues/141).

The module has no third-party requirements and no `go.work`. Session tooling
belongs to [#137](https://github.com/odogono/odgn-talk/issues/137); the planned
`session/`, `driver/` and `cmd/northtalk/` boundaries follow
[ADR 0046](../../docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md).

## Build and test

Use Go 1.27 and Bun 1.4.2. From the repository root:

```sh
bun install --frozen-lockfile
bun run unicode:check
cd impl/go
go build ./...
go vet ./...
go test -race -v ./...
go run ./cmd/corpus --check-passing
gofmt -l .               # must print no paths
```

Unicode tests verify source hashes in `.cache/unicode/18.0.0/`, all five columns
of `NormalizationTest.txt`, scalars absent from its first column, every
`GraphemeBreakTest.txt` row and C/S folding against `CaseFolding.txt`. Missing or
corrupt sources fail. The import-policy test refuses platform Unicode tables,
`strings` case functions and `golang.org/x/text`.

Regenerate from the repository root:

```sh
bun run go:generate
bun run unicode:generate
bun run syntax:generate
bun run check
```

Emitters read Spec Data Files and pinned UCD sources, import no TS Core code and
use `gofmt`. Their `--check` modes refuse missing or stale output without writing.

## Front-end and lowering checks

Tests reconstruct every grammar sketch, Corpus source and stdlib Library,
and pin the first errors in `tools/grammar/broken.talk`. The Disassembly Cases
match byte for byte, including pools, slots, positions,
Unwind Tables and Event Tables; together they emit every declared opcode.
Stdlib signatures can be linked for disassembly without executing Libraries.
All load-diagnostic Trace Cases replay through public `Load`, including
`initialiser failed` at the raising instruction's source-map position.

Raw Text Literals preserve backslashes and placeholders. Backticks decode
escapes and accept nested multiline Interpolation Holes. Both forms support
exact closing margins and physical newline normalization; hole-free forms also
work in literal-only Text positions. Holes retain Constant and Guard
restrictions and lower to ordinary concatenation instructions, with generated
joins mapped to `${`. Invalid closing margins identify the first non-whitespace
source scalar; paired Corpus cases also pin interpolation Fuel and allocation
faults and Segment rollback.

Implicit Script Variable initializers allocate Nothing slots without emitting
stores. Explicit `= nothing` emits its constant and store, as chapter 8 requires.
This keeps canonical code positions aligned with the existing Corpus.

Handler call-graph analysis rejects plain calls to may-suspend Handlers and
function-style calls that could suspend. Grant-aware loading checks Operation
names, modes, argument counts and literal Shapes, including `say`. Decisions
also check `veto` and `pass` reachability before suspension. Library linking,
Library needs and Host Object property Shapes remain part of
[#134](https://github.com/odogono/odgn-talk/issues/134). The subset rejects
`wait for` in a Library as `not in a library`; imports and Library execution
remain unavailable.

## Values and codecs

`Dec` reads number syntax without rounding. `FromFloat` uses shortest round-trip
digits. Decimal printing retains trailing zeros; integer accessors refuse
fractions and overflow, and `Float64Lossy` rounds nearest, ties to even.
Constructors reject invalid input with `HostError{Code: InvalidValue}`.
`InstantFromTime` drops zone and monotonic readings and panics with that Host
error outside years 0001–9999; `Instant` returns the refusal instead.

`Value.String` uses chapter 11's display form. `EncodeValue` preserves supported
kinds and numeric exponents. `DecodeValue` rejects malformed UTF-8, lone
surrogates, duplicate NFC keys and noncanonical Base64, re-parses Text Patterns
and resolves Object tags through its resolver. Plain JSON refuses non-JSON
kinds with `not encodable`, including `kind` and the first depth-first `path`.
Function Values have Home identity, capture equality and accessors, and are
refused by storage encoding. Object registration belongs to #134.

Quantity comparison retains sequentially rounded Base Unit magnitudes beyond
the number limit. Some huge Unit exponents remain impractical when interval
bounds and stable-coefficient shortcuts cannot decide the comparison.

## Machine execution

`machine.Initialize` evaluates initializers without Run charges.
`InitializeBound` supplies Home identity before creating Function Values.
`StartDelivery` tries arity-compatible Handler Clauses in source order; local
Handler calls use the same clause-failure rules. `Run.Execute` returns between
instructions on preemption, keeping frames, locals, stacks and unwind state as
plain data. It uses no saved Go callback or goroutine continuation.

Standalone execution covers chapter 3/4 arithmetic, Quantities and dates,
conversions, folded structural comparison, containers and writes, snapshot
iteration, branches, loops, catch/finally, binary construction/destructuring,
Text Patterns and replacement, and non-suspending local Function Values with
captures and named defaults. The Built-ins include number functions, IEEE float
codecs, pinned case mapping, date fields and fixed-offset conversion, and Function
Value metadata. Object lifecycle Built-ins depend on #134.

Generated Cost Model 0 charges precede committed instruction changes. Fuel,
allocation, depth and dynamic Pattern Size faults leave the faulting instruction
uncharged and restore Script Variables to the Segment's starting snapshot. Range
materialization and padding have budget preflights before construction.
Persistent State counts variables, mailboxes and retained Run frames; a final
return checks the state that will remain. Cancellation runs finally cleanup
under its separate Cleanup Budget. Execution tests cover each chapter area and
pin the text-model fixtures' Fuel, allocation, positions and final variables.

Object Message Path `send` instructions, foreign Function Value calls with
`and wait`, imported calls and Object properties stop at a
`Blocked` implementation boundary with the instruction and operands
untouched and no charge for that instruction. The pending Run remains visible
and a Request remains unsettled. A Decision remains open if it has not sealed
before that boundary. Message Paths and Broadcast Decisions belong to #134;
complete cancellation and Stop Script acceptance to
[#135](https://github.com/odogono/odgn-talk/issues/135),
and save/restore to [#136](https://github.com/odogono/odgn-talk/issues/136).

## Text Patterns

`internal/machine/pattern.go` compiles chapter 8's normative Pike VM programs
and matches whole Characters using the pinned Unicode tables. Matching keeps
threads in priority order and charges every visited list's thread count,
including discarded empty searches. Boolean searches stop at the first
accepted match; Match Searches retain the preferred match, converted Captures
and their Character ranges. `lazily` changes only its element's own repetitions.

Composition accepts Text and Text Patterns, preserves spliced Captures and
rejects duplicate names or Captures inside repetitions. Canonical source
omits empty nested groups and separates a leading group with `< <`.
`make-pattern` uses the resulting program size for its Fuel and allocation;
loading and initializers remain uncharged. Literal size checks count every
copy of the singular class and emit no code for a zero count.

The step-2 acceptance test runs all eight reviewed `corpus/text-patterns/`
cases through the public embedding API and protects their passing-list entries.
Additional tests pin normative programs, composition errors, conversions,
absent Captures and compilation charges. Three new regression cases for empty
literals, counted program sizes and wrong-kind splices agree on both Cores;
their `Unblessed` headers remain until the first human review.

`matching-fuel-exhaustion` and `pattern-size-made-at-run-time` also pass, but
complete limits acceptance belongs to
[#135](https://github.com/odogono/odgn-talk/issues/135).
`pattern-size-literal-limit` also passes through ordinary Reload; Go save/restore
remains [#136](https://github.com/odogono/odgn-talk/issues/136).

## Group embedding

`New`, `NewGroup`, `Load`, Script/Group `Deliver`, `Request` and `Decide`, `Pump`,
`Inspect`, `Counters`, `CancelRun`, `Reload` and `TraceSink` implement their handoff
signatures. Core compilation caches are mutex-protected and Groups have separate
live state. Load supports standalone Scripts with named Capability Grants;
Object bindings are refused. Other unimplemented public declarations are omitted.

Any-goroutine deliveries reserve mailbox capacity before joining the input
queue. A Pump takes one Clock reading, drains accepted inputs in order, and
visits Scripts in load order, one Run per turn. Fuel Slice overrun becomes debt
on the next Pump; Fuel Cap limits the Group. Request cancellation joins the same
queue, and Pending results settle after Pump records. Worker reentry, backwards
Clock readings, invalid values and Function Values from other Groups are refused.
Clock readings outside the language's year 1–9999 range currently panic during
conversion; returning `invalid value` for them is tracked in
[#282](https://github.com/odogono/odgn-talk/issues/282).

`Script.Reload` checks and initializes new code against kept, unrevoked Grants
before discarding old work. A rejected Reload leaves calls and revocation state
intact. Successful Reload abandons pending calls without Script finally cleanup,
drops queued messages, settles Requests/reply senders as stopped, carries variables
by name when requested, and preserves counters. Carry uses the active Segment's
rollback base for preempted Runs; Function Values from the old code become stale.
Sticky `Stop`, `Extend`, Library replacement and scoped lifecycle remain deferred.

### Ordinary Capability Operations

`Core.DefineCapability` copies Operation declarations and validates their modes,
Shapes, costs and Host functions. `Grant` selects Operations, and `GrantAll`
selects the whole definition with an opaque Host binding. Load copies each named
Grant, so aliases and Scripts have independent revocation state. Shapes include
scalar kinds, exact Units and Unit kinds, Lists, Maps, unions and Optional values.
`AnyShape` accepts data and refuses nested Function Values; `ValueShape` accepts
all Values. A trailing suffix of Optional arguments may be omitted, and the Host
receives only supplied arguments, preserving explicit Nothing.

Immediate `ask` and fire-and-forget `tell`/`say` execute inside the pumping Run.
Argument checks and revoked Grants fail before charging or calling the Host.
The base 10 Fuel, declared Fuel and allocation, and pending dispatch charge are
paid atomically before the Host crossing. `Call.Charge` draws additional Fuel
while the Host function runs; a refused charge faults the Run even if the Host
swallows `ErrLimit`. Immediate results are checked and their conversion charged
before being stored in `it`; fire-and-forget calls leave `it` unchanged. An
accepted Host effect remains committed when later conversion or Script code faults.

A valid custom `ScriptError` raises its code, message and Data with Operation
identity. Catalogue codes, reserved Data keys, undeclared codes, invalid results,
plain errors and panics become `host error`, with Host-only detail in `CallFailed`.
Calls carry the named Grant, binding, Pump Clock, Run and Segment identity.
Caught raises precede subsequent Host call records. Host inputs accepted during
a call join the next Pump; worker reentry is refused.

`Script.Grants` returns fresh, sorted Operation lists. `GrantsAsUsed` trims direct
uses across the whole Script, including unused function bodies. `Script.Revoke`
queues revocation in Host-input order; retained aliases remain independent.
Library needs and imported uses are deferred with Library linking.

Suspending `ask … and wait` invokes `Start` once after the same atomic precharge.
`Call.Answer`, `AnswerWithCost` and `Fail` may run on any goroutine, append Host
inputs and call `OnReady`; answers queued during `Start` wait for the next Pump.
The waiting Run retains a 48-byte pending call, then its answer or failure Data
when ready. Validation, result/Data conversion and any late Fuel are charged on
its resuming turn, under the Run budgets, Script slice and Pump cap. Conversion
faults roll back that Segment while preserving earlier committed effects.
Duplicate and abandoned settlements are recorded and ignored.

`MaxPending`, or the effective Run `MaxWait` when it is zero, bounds each call
from suspension using the Pump Clock. Timeout raises `timeout` with `after` and
Operation identity. Timeout, cancellation, Reload and Join abandonment cancel
pending Call Contexts; revocation leaves in-flight calls alone and blocks later
starts. Inspection reports `ask-wait` and pending ids. No turn callback is retained
in machine state.
Standard Capability factories, Object execution, Capability Scopes and
Segment-bound effects remain part of #134. Definitions that request Scopes or
Segment-bound behavior are refused. Ordinary calls have no scope, are not
automatic. Immediate and fire-and-forget calls carry a background Context.

Duration waits retain heap frames and release the Script to run other queued
work. Their deadlines use the Pump's Clock reading plus an exact duration,
rounded to whole nanoseconds, half even. Due timers enter the work queue after
Host inputs, ordered by deadline and then creation. Zero and negative waits
resume only in a later Pump. `NextDeadline` reports the earliest retained timer.
Inspection lists suspended and ready Runs in start order; Persistent State
counts every retained Run.

Local Handler and Function Value calls with `and wait` retain their call frames.
Resumption starts a new Segment snapshot at its actual turn; Fuel and allocation
remain cumulative over the Run. A suspension charges the wait before checking
retained Persistent State. Cancelling a suspended Request removes its timer and
queues finally cleanup in input order, preserving committed earlier Segments.
`CancelRun` also queues cancellation and may land during a Pump at an instruction
boundary; ordinary settlements still wait for the next Pump.
Faulted cleanup rolls back only its own Segment. Deadlines beyond `time.Time`'s
representable range stop at the untouched wait boundary; durations beyond
`time.Duration` are supported when their deadline fits `time.Time`.

Message waits support one-line `wait for`, optional timeouts, and block-form
`when`/`after` branches. Every pending wait observes a dispatched message in
registration order before Handler dispatch, without consuming it. Event tests
use captured locals from registration and current Script Variables; failed
patterns bind nothing, and Guard errors skip and report their branch. The first
matching branch wins. Timers choose the earliest deadline, with source order
breaking ties. A match retains its message and bindings until its Run resumes;
cancellation removes subscriptions, timers and ready events before finally cleanup.
Inspection shows `wait-for` or `wait-for-any` and the earliest deadline, if any.

Event tests pay their own instructions, without a Handler Clause dispatch
charge. Their Fuel and allocation accumulate on the waiting Run, uncapped
there until its next resumed instruction. All observation work counts toward
the Pump's receiving Script slice and Group cap. Observation finishes atomically
even past those budgets; the incoming Run is then preempted before its first
instruction, ahead of newly ready waiters, and slice overrun becomes debt.
Internal `error` messages are observed even without an error Handler. Named
Script filters resolve when waiting begins; missing names raise `object gone`,
and other non-Object filters raise `wrong kind`. Object filters remain dependent
on Object registration, while Object-addressed sends remain deferred.

Non-waiting `send` to a named Script or an ownerless Script's `me` joins the
receiver's work queue immediately during a Pump. Receivers never run inside the
sender; FIFO order and sender Run identity are preserved. Named receivers can
load after their senders, and their existence is checked when the receiver is
loaded onto the operand stack. Missing names raise `object gone`; ordinary
non-Object Values raise `wrong kind`. Mailbox capacity includes Host inputs
accepted during the Pump. A full mailbox raises `mailbox full`, with the Script
name as `to`, at the paid send; no message is delivered.

The sender pays Cost Model 0's message charge: 20 Fuel plus the rounded-up
message size divided by 32, allocating the message size. The message counts
against the receiving Script's mailbox and its Run uses that Script's own
limits. A self-send updates the sender's retained-state base immediately, so
the queued message counts at its next Persistent State check. Budget faults
prevent delivery; later sender faults, errors or
cancellation preserve already sent messages. Plain `send` leaves `it` unchanged.
Receiver Names remain plain frame data across preemption and contribute no
Value size to Persistent State.

`send … and wait` to a named Script or an ownerless `me` uses the same mailbox
and message charge, then releases the sender's Script until the receiver ends.
Each accepted waiting send gets a call id in that Run's start order. A reply
resumes the sender at a new Segment and is stored in `it`, with no further
send charge. Receiver errors, Limit Faults, cancellation, dropping and unmatched
messages raise `send failed` at the sending instruction, with `reason` and,
for an error, the receiver's error map. A send's reply wait is bounded by the
sender Run's `MaxWait`, including a tightened Delivery override. A timeout raises
`timeout`, with `after` in milliseconds. Sender cancellation runs its cleanup;
cancellation, timeout and a retaining-state fault abandon the reply without
cancelling the receiver.

A pending reply counts 48 bytes toward the sender's Persistent State at
suspension. Once the receiver ends, the ready sender retains the reply Value,
or the receiver's error map for a failure, in place of that call. Resumption
charges, including unwinding through local Handler frames, spend the Pump's
Fuel cap and the Script's slice before following instructions run. Inspection
reports `send-wait` and the pending call id, with no `until` for `MaxWait`.
Object Message Paths and foreign Function Value calls remain at their
untouched implementation boundaries.

`wait for all … end` supports ordinary Capability calls and waiting sends to named
Scripts and ownerless `me`, including mixed Joins. Each member starts where reached, leaves `it` unchanged, and receives a
call id in start order. The closing `end` suspends once; its ready resumption
assembles replies in start order and allocates their result List. A Join that
starts no dynamic members returns `[]` immediately without a Segment boundary.
The first arriving failure raises the member's own error with its 1-based `index`
at the closing `join-end` instruction; Script receiver failures use `send failed`.
Other pending members are abandoned in start order, cancelling Capability Contexts
while Script receivers continue. Capability results convert and charge in start order. Body errors, limit faults and sender
cancellation also abandon pending members; cancellation runs normal cleanup.

Each pending member counts 48 bytes toward Persistent State, including across
preemption in an open Join. Early replies replace their pending-call size with
the retained answer; a ready failure retains its Capability Data or receiver error map. Replies
arriving before a preempted Join closes are kept in arrival order. A Run's
`MaxJoin`, including a tightened Delivery override, faults before charging the
member that would exceed it. Each member's `MaxPending` or effective `MaxWait`
begins when the Join closes and is not reset when another member replies.
Script members share the Run's `MaxWait` deadline;
Pump Fuel Caps, Script Fuel Slices and unwind charges still apply when the caller resumes. Inspection reports
`join-end`, pending member ids in start order, and no `until` for call timeouts.

A plain local Handler call to a may-suspend Handler is rejected with
`missing and wait`; function-style calls to a may-suspend Handler are rejected
with `can't suspend here`. A call cannot hide a nested Join. Object Message Paths
remain at their untouched boundaries.
Join failures and timeouts use the closing `end` token's source position,
for bare `end` and `end wait`, including Joins in local Handlers and block
Lambdas. The `join-end` PC and 1-based member `index` stay unchanged; a failed
reply retains the receiver's own Error map and source position.
Go still attributes a Lambda Error's `at.handler` to its generated body name
rather than the enclosing Handler or function, and captured Function Values
have allocation/Persistent State differences from TS;
[#289](https://github.com/odogono/odgn-talk/issues/289) tracks their Spec
reconciliation. The closing token's line and column are correct in either body.

Single-Script Decisions expose a `Deciding` future and a `Decided` report. An
ordinary Handler allows after its successful dispatch charge; an unmatched
message also allows. A matching pending wait allows a Decision before Handler
dispatch. A deciding Handler keeps its Verdict open through
preemption until its first Segment ends or suspends, sealing `Allowed`, or
until `veto` completes its finally cleanup, sealing `Vetoed` with its reason.
The vetoed Run completes with Nothing. Errors, faults, drops and cancellation
before sealing report `Undecided` with the Run's outcome. Reports appear at
the seal, and futures settle after the Pump's records. Context cancellation
after sealing leaves the continuing Run alone. Load checks reject vetoes
outside deciding entry Handlers, in locally called Handlers, or reachable
after suspension, and reject passes reachable after suspension. Message Paths
and Broadcast Decisions remain deferred, as does routing through Object handles.
For a Script with no owner, `pass` completes its Run and reaches the end of the
path, reporting `unhandled` and allowing an open Decision; Requests fail with
`send failed`, reason `unhandled`.

Queueing Policies apply to the selected entry clause after Destructuring and
Guards. `queued` parks later Runs FIFO while the mailbox keeps flowing;
`dropping` ends a new overlapping Run with outcome `dropped`; `replacing`
cancels earlier Runs whose Verdicts are no longer open and queues their finally cleanup in their existing work
order. Failed Guards never affect a clause's queue. Policy dispatch survives
preemption, and parked and dropped Runs pay dispatch once without entering the
body. A replacement with unpaid dispatch cancels earlier Runs only after
paying the first instruction's combined charge. Parked Runs appear as
`Parked`, count toward Persistent State, and do not
consume mailbox slots. A clause releases its first parked Run when its last
unparked Run ends, including errors, faults and completed cancellation cleanup.
A resumed parked Run starts a new Segment snapshot and keeps its Run budgets.

An uncaught error queues a separate `error` message behind the existing mailbox
messages, with the failed Run as its sender. Error Handler Clauses use ordinary
Destructuring and Guards, including the text-code shorthand. Their `during`
binding holds the failed message before Guard tests and survives clause skips,
local calls and preemption. An unmatched internal error never reports `unhandled`,
and an error Run that errors sends no further message. A full mailbox, including
reserved Host inputs, drops the error with an `error-dropped` Trace note. Queued
errors count toward Persistent State and can resume pending `wait for error`
observers before Handler dispatch.

Inspection and counters are worker calls; a refused call with no error return
panics with `HostError`. Trace callbacks run without the input queue lock.

## Corpus runner

From `impl/go/`:

```sh
go run ./cmd/corpus --list
go run ./cmd/corpus
go run ./cmd/corpus text-model/chunk-write-padding
go run ./cmd/corpus --check-passing
```

The gate contains 134 cases: all 12 text-model cases, all 38 load-diagnostic
cases, all seven Disassembly Cases, the three other Value Encoding cases, and
74 additional math, dates, Quantities, Bytes, limits, Text Pattern, error
delivery, suspension, observation, Queueing Policy, Decision and ordinary Capability cases. Trace cases replay through the
public embedding interface, with exact records, costs and final state. Tests
separately enforce the full 60-case step-1 set and eight reviewed step-2 cases,
so removing a required case cannot silently
shrink the gate. Five reviewed Core-error cases also pin retained error-map
sizes, and two new error-delivery regressions agree on both Cores. Their
`Unblessed` headers remain until human review of the first blessing. Four
reviewed wait cases pin zero waits, deadlines, rollback and nested frames.
Two new suspension regressions also agree on both Cores before their first
blessing, covering work ordering, cap-held resumptions, nanosecond rounding and
long durations. The reviewed Queueing Policy case also passes; two new
policy regressions agree on both Cores before blessing, covering selected
clauses, Guard skips, preemption, and dispatch and Persistent State limits.
Their `Unblessed` headers remain until human review. Listing a new regression
case here protects it while its first human blessing review remains pending.
Three reviewed Decision cases pin errors, faults and preemption before sealing.
A new Decision regression agrees on both Cores and retains its `Unblessed`
header for first human review; it covers dispatch charges, dropping, veto
cleanup, unmatched messages and a Run that resumes after its Verdict seals.
Four observation traces reproduce the corrected event-test charge on both Cores,
including atomic cap/slice overruns, debt, late Run faults and Decision sealing.
A new observation regression also agrees on both Cores, retaining its `Unblessed`
header for first human review; it covers pinned locals, live Script Variables,
branch priority, Guard errors, non-consuming matches, sender filters, timeouts
and internal error observation. The reviewed `suspension/wait-for` case now
agrees on Go, including Script sends and sender filters. Three new send regressions
agree on both Cores and retain their `Unblessed` headers for first human review;
they pin FIFO and self sends, full/missing/invalid receiver errors, record order,
immediate delivery surviving a sender error, and preempted receiver identity
without Value size, and same-Segment Persistent State checks after self-send.
Three other corrected TS traces need Go facilities outside
this slice; their remaining Go parity is tracked in
[#277](https://github.com/odogono/odgn-talk/issues/277).

The reviewed `suspension/send-and-wait` Trace also passes unchanged, with replies,
receiver errors, unmatched messages and timeout. Three new paired reply cases
pin resumption unwinding under a Pump cap, pending-call retention faults, and
replacement cancellation with cleanup and ignored late replies. They keep
their `Unblessed` headers for first human review.

Six reviewed ordinary Capability cases and `limits/mailbox-depth` pass unchanged: calls, argument Shapes,
load checks, Host failures, charge faults and omitted optional arguments.
Two new cases agree on Go, TS and TS save/restore before blessing:
`capabilities/declared-allocation` pins atomic pre-Host charging in both modes;
`capabilities/ordinary-grants` pins alias bindings, revocation, trimming and caught
raises before later Host calls. Their `Unblessed` headers await first human review.

A listed regression or missing case fails; an unlisted passing case is reported
for addition. Other cases retain first-divergence output or `SKIP` with a reason
for unsupported facilities. Explicitly selecting an unsupported case fails.
Transcript and save/restore backends belong to the later steps. The Go runner
has no blessing mode and never changes expected Corpus lines.
