# Go Core

The Go Core is module `github.com/odogono/odgn-talk/impl/go`, with public root
package `northtalk`. It provides immutable values, decimal arithmetic, pinned
Unicode text, a front end and standalone Abstract Machine execution. Its Group
embedding subset loads Scripts, accepts Deliveries and Requests, pumps Runs and
emits canonical Trace records. The Spec, Data Files and Conformance Corpus are
the authority; the TS Core is not a reference
([ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

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
and pin the first errors in `tools/grammar/broken.talk`. The seven units in the
six Disassembly Cases match byte for byte, including pools, slots, positions,
Unwind Tables and Event Tables; together they emit every declared opcode.
Stdlib signatures can be linked for disassembly without executing Libraries.
All 30 load-diagnostic Trace Cases replay through public `Load`, including
`initialiser failed` at the raising instruction's source-map position.

Implicit Script Variable initializers allocate Nothing slots without emitting
stores. Explicit `= nothing` emits its constant and store, as chapter 8 requires.
This keeps canonical code positions aligned with the existing Corpus.

Handler call-graph analysis, Library linking, Grants, Capability modes and Host
Object property Shapes belong to
[#134](https://github.com/odogono/odgn-talk/issues/134). The diagnostic families
`wrong argument`, `unknown operation`, `wrong mode`, `missing and wait`,
`import cycle`, `missing grant`, `not in a library`, `veto outside a decision`,
`after a suspension`, `wrong message` and `bad suffixes` depend on those facilities.
The current subset already rejects `wait for` in a Library, as `not in a library`.

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

Joins and `send` instructions, foreign Function Value calls with
`and wait`, imported calls, Capability effects and Object properties stop at a
`Blocked` implementation boundary with the instruction and operands
untouched and no charge for that instruction. The pending Run remains visible
and a Request remains unsettled. A Decision remains open if it has not sealed
before that boundary. Message Paths, Broadcast Decisions and
pending calls belong to #134; complete cancellation and Stop Script acceptance to
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
`pattern-size-literal-limit` requires Reload from
[#136](https://github.com/odogono/odgn-talk/issues/136) as well.

## Group embedding

`New`, `NewGroup`, `Load`, Script/Group `Deliver`, `Request` and `Decide`, `Pump`, `Inspect`,
`Counters` and `TraceSink` implement their handoff signatures. Core compilation
caches are mutex-protected and Groups have separate live state. Load supports
standalone Scripts; unavailable Grant and Object bindings are refused rather
than ignored. Other unimplemented public declarations are omitted.

Any-goroutine deliveries reserve mailbox capacity before joining the input
queue. A Pump takes one Clock reading, drains accepted inputs in order, and
visits Scripts in load order, one Run per turn. Fuel Slice overrun becomes debt
on the next Pump; Fuel Cap limits the Group. Request cancellation joins the same
queue, and Pending results settle after Pump records. Worker reentry, backwards
Clock readings, invalid values and Function Values from other Groups are refused.

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
on Object registration, and ordinary Script sends remain deferred.

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

The gate contains 101 cases: all 11 text-model cases, all 30 load-diagnostic
cases, all six Disassembly Cases, the three other Value Encoding cases, and
51 additional math, dates, Quantities, Bytes, limits, Text Pattern, error
delivery, suspension, observation, Queueing Policy and Decision cases. Trace cases replay through the
public embedding interface, with exact records, costs and final state. Tests
separately enforce the full 50-case step-1 set and eight reviewed step-2 cases,
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
and internal error observation. Four other corrected TS traces
need Go facilities outside this slice. Their maintainer-approved TS-only
corrections do not establish Go parity, which remains tracked in
[#277](https://github.com/odogono/odgn-talk/issues/277).

A listed regression or missing case fails; an unlisted passing case is reported
for addition. Other cases retain first-divergence output or `SKIP` with a reason
for unsupported facilities. Explicitly selecting an unsupported case fails.
Transcript and save/restore backends belong to the later steps. The Go runner
has no blessing mode and never changes expected Corpus lines.
