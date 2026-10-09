# Go Core

The Go Core is module `github.com/odogono/odgn-talk/impl/go`, with public root
package `northtalk`. It provides immutable values, decimal arithmetic, pinned
Unicode text, a front end and standalone Abstract Machine execution. Its Group
embedding interface loads Scripts, accepts Deliveries and Requests, pumps Runs and
emits canonical Trace records. The Session Host provides Entries, Session
Commands, a REPL and deterministic Transcript replay. The Spec, Data Files and Conformance Corpus are
the authority; the TS Core is not a reference
([ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

A `tell g` block calls each line's Operation of the Grant `g` ([ADR 0063](../../docs/adr/0063-a-tell-block-calls-several-operations-of-one-grant.md)). The parser reads `end` as the block's close and any other first word as an Operation name. Each line is an `ask` until the checker resolves it against the unit's Grants: a fire-and-forget Operation's line without `and wait` becomes a `tell`, once, so an importing Script's recheck tests the Library's lines as compiled. Lines then lower, check suspension and join as the one-line calls they stand for, at their Operation names. A Grant the unit doesn't hold is one `unknown operation` at the block's receiver. With no Grants, as in Disassembly Cases, every line lowers as an `ask`. `DefineCapability` refuses `end` as an Operation name.

Any `repeat` head accepts `collecting e into v` ([ADR 0059](../../docs/adr/0059-a-repeat-may-collect-its-results.md)). The target is a local initialized to `[]` before the head is evaluated. Each completed pass appends one value after the body; `next repeat` and `exit repeat` skip it, and an error keeps the partial list. Bodies may read the target and suspend, but Container writes, pattern bindings and inner collecting clauses cannot write that target. Targets clash with Script Variables, Constants, well-known objects and the loop's own iteration bindings.


## Task navigation

**Recovery Offers:** this Core parses, checks, lowers and executes offers and two-phase catch search. Ordinary catches test before cleanup; recovery policy can choose a retained local/Library/same-Run action. `offerAvailable`, canonical metadata, costs and choice/entry Trace records are implemented. Nested policy searches stay within their selection boundary; escaping policy Errors carry `during` outward, transfer cleanup preserves or cancels choices as appropriate, and cancellation enumerates dispatch-local and retained scopes once. Dispatch saves retain control stacks, shared owner locals, pending transfers, cleanup progress and attempt numbers. Restore validates every retained code/body/PC, ownership chain, target and cleanup reference before resuming; search and lookup preempt only at the following instruction boundary. [Save/restore evidence](../../docs/reviews/recovery-offers-saves/README.md) covers ordinary catches, nested policy, transfer cleanup, action entry and cancellation. Session Scripts can choose Library offers and replay their Transcripts. The shared TS debugger and Playground follow active dispatch control and display retained frames with shared owner locals; Go reproduces their execution Traces through its replay backend. See the [tooling/session evidence](../../docs/reviews/recovery-offers-tooling/README.md) and [language rules](../../spec/04-expressions-and-statements.md#recovery-offers).

Use the [Go task map](NAVIGATION.md) for implementation files, Spec links, tests and root-relative check commands.

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
  Exact addition, subtraction and multiplication use checked `int64`
  coefficients when possible, preserving the decimal quantum and falling back
  to `math/big` for overflow or rounding.
- `internal/value/` owns values, Units, comparison, display and strict JSON.
  Containers copy input slices; public accessors return copies.
- `internal/syntax/` owns lossless UTF-8 lexing and parsing. `Tree.Source()`
  reconstructs every source byte; only Text literal values are NFC.
- `internal/check/` resolves declarations, body slots, captures and initializer
  dependencies. Diagnostics sort by source position, then catalogue order.
- `internal/lower/` produces canonical instructions, source maps, Unwind Tables
  and Event Tables. Labels use instruction indices, never byte offsets. Its
  Go-private byte encoding round-trips each body's instruction stream.
  Operands, Cost Model keys and suspension flags are resolved after labels
  receive their final instruction indices; runtime operand views are read-only.
- `internal/machine/` executes checked code with heap frames, detached operand
  evaluation, clause dispatch, unwind state and generated Cost Model 0 charges.
  Trial stacks and locals reuse detached buffers within an execution turn;
  accepted charges copy their results back before effects commit. Returned
  call frames supply cleared buffers for later calls in that turn. These
  temporary buffers are discarded on preemption, suspension or completion.
- `internal/snapshot/` encodes plain heap data and explicitly named Group/code
  references; Host bindings and futures stay outside snapshots.
- `internal/trace/` orders records and keys by `corpus.toml`. It removes the
  Core's non-parity error wording from Trace values, including nested errors,
  while preserving Script and Host data named `message`.
- `session/` owns Entries, implicit Script Variables, atomic redefinitions,
  foreground/background Runs and Session Commands. It consumes Trace records
  to present output; inspection occurs only for explicit inspection commands.
- `driver/` owns Transcript parsing, recording/replay and terminal interaction;
  `cmd/northtalk/` connects it to filesystem I/O, stdin and Ctrl-C.
- `internal/corpus/` reads setups and runs encoding, disassembly, Trace and
  Session Transcript backends. `cmd/corpus/` provides selection, first-divergence output and the gate.
- `internal/fuzz/` runs differential fuzz cases through the corpus runner's
  incremental replay Host, resolving symbolic Host Inputs as the fuzzer's TS
  runner does. `cmd/fuzzworker/` serves it over the
  [fuzzer's worker protocol](../../tooling/fuzz/README.md#dual-core-mode).
- `internal/apicheck/` compares root exports and signatures with `talk.go`,
  including promoted members. Missing declarations are reported without failing
  until [#141](https://github.com/odogono/odgn-talk/issues/141).

The module has no third-party requirements and no `go.work`. Its Core,
`session/`, `driver/` and `cmd/northtalk/` boundaries follow
[ADR 0046](../../docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md).

## Build and test

Use Go 1.27 and Bun 1.4.2. From the repository root:

```sh
bun install --frozen-lockfile
bun run unicode:check
go -C impl/go build ./...
go -C impl/go vet ./...
go -C impl/go test -race -v ./...
go -C impl/go run ./cmd/corpus --check-passing
gofmt -l impl/go               # must print no paths
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

Emitters read Spec Data Files, normative Standard Library source and pinned UCD sources, import no TS Core code and
use `gofmt`. Their `--check` modes refuse missing or stale output without writing.

## REPL and Session Transcripts

**Implemented commands:** [Session observation](../../spec/session-observation.md) adds `:describe`, `:inspect`, `:apropos`, `:trace`/`:untrace`, `:fuel`, marked declaration docs and object-crossing Transcript envelopes. This Core implements the public Run accounting reports, `RestoreResult.reports`, Declaration Documentation ([#436](https://github.com/odogono/odgn-talk/issues/436)), `:describe` and `:apropos` ([#437](https://github.com/odogono/odgn-talk/issues/437)), and `:trace`, `:untrace` and `:fuel` ([#438](https://github.com/odogono/odgn-talk/issues/438)). It also implements `:inspect` and object-crossing envelopes ([#439](https://github.com/odogono/odgn-talk/issues/439)); coordinated release review remains in #370.



- **Value inspection and object Transcripts:** `:inspect` accepts one expression, including a multiline expression, and evaluates it once. Syntax and checking diagnostics use the expression’s own source positions; statements, declarations and trailing input give `! bad arguments`. Passive rows show the held value, sizes, sorted map fields, Function metadata/docs or the actual Object Kind's properties. An object then runs the generated normative reader as a separate ordinary request with the current limits; getters run once in code-point order and print one-level results or parity-safe errors. Generated readers stay out of Session Source/export. New recordings include initial `% setup` and portable Function exposures; recordings without `%` still replay with their original empty-object setup.
- **Object adapters:** supply `Objects(context)` in `session.Environment`; use `Objects.DefineKind` and `.Object` for initial and dynamically returned identities. `.Request(map[string]any)` builds and executes a normalized external worker request, recursively encoding held Values; `.Action(Envelope)` accepts raw Value Encoding, with `.Encode` for Function references. The adapter records actual callback boundaries, ordered actions, errors and synchronous refusals. Supply `ResolveObject` for live Restore. Standalone replay creates dummy native identities and consumes these records through normal Core Shape checks and costs; it does not invoke the original getter or external I/O. Function references preserve actual exposed Values and nested map insertion order, and become invalid after successful Restore. Corpus replay uses the same envelopes in both Trace modes. [The proposed first expectations](../../docs/reviews/object-inspection/README.md) still await human first-blessing review.

Independent Go Trace replay currently normalizes decomposed source-bearing text fields, which can change Code identities ([#456](https://github.com/odogono/odgn-talk/issues/456)). Standalone Transcript input preserves those bytes, and runtime Text Values still use the pinned NFC/grapheme rules.

- **Declaration Documentation:** `--|` blocks attach to the next top-level declaration as the specification says. A leading block keeps an Entry `NeedsMore`, and the Host refuses a block that documents nothing with `! bad arguments`. The source a declaration was entered with keeps its block, through redefinition, export and reload. `Documentation(name)`, `LibraryDocumentation(library, name)` and `FunctionDocumentation(value)` return the documentation. Each Handler Clause has its own entry. An Import resolves to the declaration that defines it, and a Built-in uses its `stdlib.toml` description. A Function Value's documentation comes from the code that defined it, so a stale one keeps its documentation, including across save and restore.
- **Tracing and Fuel:** the Session Host reads only the public Run accounting reports for these commands. `:trace` filters latch a dispatched Run by its message Selector when it starts; a Command Call shares its caller's Run and is not traced separately, and a Function Value's Run has no Selector to match. `trace start` and `trace end` rows follow a Host call's ordinary output, and Fuel rows follow them. `:fuel <entry>` measures the Entry's root Delivery and every Run and message spawned from it, summing each member Run's latest cumulative Fuel. It stays pending until the root's causal work reports no live Runs and no queued messages. `NeedsMore` waits for a multiline `:fuel` Entry. `:save` keeps filters, latched Runs and measurements; `:restore` prints `fuel abandoned` for each measurement still pending, then continues from the saved ones. The `sessions/observation` case pins the output on both Cores.
- **`:describe` and `:apropos`:** both read declaration source and the Built-in catalogue, so they execute nothing. Describing a current Script Variable takes one explicit `vars` snapshot for its value rows; no other lookup reads the Group. A signature ends at the declaration's grammar head: a function's or Handler's head line, or a Constant's or Script Variable's name. A stale Function Value keeps its original name, arity and documentation through save and restore, even after its executable code is discarded. Describing an Object variable renders its actual Kind metadata without calling getters.


From `impl/go/`, run the Go REPL or record/replay a Transcript:

```sh
go run ./cmd/northtalk
go run ./cmd/northtalk -transcript session.transcript -trace case.trace
go run ./cmd/northtalk -replay ../../corpus/sessions/save-restore/session.transcript
go run ./cmd/corpus sessions/save-restore
```

Enter one declaration, statement or expression. Incomplete Entries continue at
`|`, including open fences and interpolation holes. Blank literal lines remain
content; final EOF diagnoses the innermost unfinished construct at its opener.
An Entry beginning with a Handler Selector's first word is a Command Call;
positional and labelled Handlers sharing that word remain distinct.
Expressions print their value. `say` calls `console.write`. Foreground
Runs wait for their console input or real-clock deadline; other suspended Runs
produce background lines when later resumed. Ctrl-C cancels the foreground Run
or drops an unfinished Entry. Ctrl-D and `:quit` exit; `:help` lists Commands.
Prompts, line editing and Ctrl-C presentation are outside Transcript parity.

The Host supports `:grant`, `:mock`, `:stub`, `:answer`, `:fail`, `:clock`,
`:limits`, `:cancel`, `:runs`, `:mailbox`, `:vars`, `:save`, `:restore`,
`:library`, `:export` and `:store`, as specified in
[chapter 12](../../spec/12-sessions-and-tooling.md). Configure Grants and mock
Operations before the first Entry. `:clock virtual 2026-09-30T10:00:00Z` makes
later Pumps deterministic; `:clock advance 1 s` resumes due Runs. Saves retain
Host stubs, limits and virtual-clock state along with the Group and adopt its
pending calls on restore. Declaration and Library replacements are atomic;
failed replacements keep the previous code and variables.

`session.New(Environment{...})` embeds the Host without terminal or filesystem
access. `Now` supplies real-clock readings; `Record` receives Transcript Items;
`Trace` receives canonical Group records; `ReadFile` and `WriteFile` support
Library loading and export; `ReadStoreFile` and `WriteStoreFile` support Store
imports and exports. Call the Host from one goroutine. The supplied built-ins
are console, clock and store; other Capabilities can be mocked. The Host
currently offers no external suspending built-in, so replay refuses `~` answer
records. The CLI loads `:library add NAME PATH` and exports ordinary Library and
starter Script files with `:export DIR`.

`driver.RunREPL` serializes Host calls and accepts an optional interrupt channel.
The caller owns its input reader and must close it to release a blocked read
when cancelling. `driver.ParseTranscript`, `WriteTranscript` and
`ReplayTranscript` use the normative UTF-8/LF format. Replay supplies recorded
real-clock readings and console answers, uses scratch export I/O, and returns
actual recorded output; the CLI fails if it differs from the original file.
Help and quit are terminal actions and are not recorded.

## Front-end and lowering checks

Argument Labels in Handler heads, Command Calls, target-first `send`, `pass`
and `wait for` form Selectors as [chapter 2](../../spec/02-grammar.md#argument-labels)
specifies. `move p to sq` names `move:to:`; positional calls retain `move`.
Selectors identify Clauses, Message Paths, wait events and their `it`, and Trace
records. Host Deliveries, Requests, Broadcasts and Decisions reject malformed
colon-containing names or mismatched argument counts at the call with `invalid value`.

`send (e) with a to r` computes its message name ([ADR 0057](../../docs/adr/0057-a-send-may-compute-its-message-name.md)).
It lowers to `send-named`, `send-named-wait` or `join-send-named`, which pop
the name below the arguments. The name is checked before the receiver:
non-text raises `wrong kind`, and text that isn't a Name or a Selector with one
argument per part raises `bad message name`. A receiver Name for a Script the
Group doesn't hold raises `object gone` at the send, after that check.

A Fallback Handler, `on any message m`, takes the messages no Handler Clause
matches ([ADR 0064](../../docs/adr/0064-a-fallback-handler-receives-messages-no-clause-matches.md)).
Its clauses are `fallback` bodies named `any message`, and `pass any message`
lowers to `pass`. `machine.StartDelivery` appends them, from every code unit,
after the Selector's clauses, with the uncharged message map `{name, args}` as
their one argument. Broadcasts, Decisions and `error` messages never reach
them, and neither do local Command Calls. A Fallback Run reports its message's
Selector as its Handler, plus `fallback`, which is derived from the selected
body's kind, so snapshots need nothing new to keep it. A receiver-last `send`
whose `with` list holds `...e` builds its arguments as one list and ends in
`send-spread`, `send-spread-wait` or `join-send-spread`, which check the name
against the list's length as `send-named` does.

Tests reconstruct every grammar sketch, Corpus source and stdlib Library,
and pin the first errors in `tools/grammar/broken.talk`. The Disassembly Cases
match byte for byte, including pools, slots, positions,
Unwind Tables and Event Tables; together they emit every declared opcode.
Stdlib sources are generated into Go unchanged and execute as ordinary Libraries.
The shared `stdlib/template-migration` regression checks `${…}` placeholders,
`$$`, literal braces, text keys, value conversion and date widths in `format`,
`formatDate` and `parseDate`, including error fields, caller positions and costs.
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
also check `veto` and `pass` reachability before suspension. Imported Handlers
carry their suspension requirement into the caller. Library restrictions reject
Script state and message facilities, including unresolved commands that would
climb a Message Path. Library `wait for`, including Joins, is rejected.
Host Object property Shapes are checked at runtime. Load and Reload use copied
property declarations to reject writes to missing or read-only properties when
the well-known binding and literal key are known. Quoted and parenthesized Text
literals count as known keys; computed keys and local aliases defer to runtime.
Compilation cache keys include setter availability, so identical source checked
against one Object declaration cannot bypass another declaration’s checks.

## Libraries and Standard Library

`Core.CompileLibrary` checks stateless source with explicit imports and Operation
Declarations. `Library.Imports` and `Needs` return copies; needs include direct,
private, unused and transitive Operation references. Code identity includes source
and dependency identities; the Host version label does not affect it.
`Group.AddLibrary` requires matching dependencies first and atomically refuses
missing or mismatched imports, reused names and reserved stdlib names. Private
names and imported names are never re-exported. Imports are linked by name,
including renames, without copying bodies into callers.

Calls, Constants, defaults and Function Values execute in the calling Script's
Run. Each frame owns its code unit, constant pool and Unwind Table, while Fuel,
allocation, depth, rollback and retained state belong to the caller. Nested
Function Values in shared Library Constants and defaults bind to each caller's
Home without modifying the compiled Library. Imported Handler clauses dispatch
in source order, and waits retain Library frames across Pump calls.

Every Group holds the seven normative Standard Libraries. Their sources are
embedded by `tools/go/generate.ts`; no TS implementation is imported. Catalogue
errors from stdlib code name the nearest call in user code, while user
Library errors retain the Library location. Reviewed traces pin ordinary calls,
Function metadata, registration, faults, unwind charges and stdlib caller errors.

Library calls to immediate, suspending and fire-and-forget Operations use the
caller's named Grant, Host binding and charge/settlement path. Loading and Reload
recheck every original Library call against the caller's modes, arity and literal
Shapes, including private, unused and transitive uses. Missing Operations report
one `missing grant` per distinct Operation at each `use` line; messages name the
first original site in direct source order followed by import order. Shared
diamond call sites are checked once per `use` line. `GrantsAsUsed` retains all
Library needs. Revocation, cancellation cleanup and late answers belong to the
caller Run, and a rejected Reload preserves pending calls.

Library frames, closures and imported constants survive full Group snapshots.
`ReplaceLibrary` recompiles transitive dependents and reloads affected Scripts
only after every dependent validates and all old effects clean up successfully.
Library Constants are shared fixed overhead, outside Script Persistent State.

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
refused by storage encoding. Group-scoped Host Objects can be registered and
resolved by the Host. Group-owned parent relationships route messages to the
nearest live Owning Script.

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
Value metadata, plus `objectKind`, `isDisposed` and Core-held Object ids.

Generated Cost Model 0 charges precede committed instruction changes. Fuel,
allocation, depth and dynamic Pattern Size faults leave the faulting instruction
uncharged and restore Script Variables to the Segment's starting snapshot. Range
materialization and padding have budget preflights before construction.
Persistent State counts variables, mailboxes and retained Run frames; a final
return checks the state that will remain. Cancellation runs finally cleanup
under its separate Cleanup Budget. Execution tests cover each chapter area and
pin the text-model fixtures' Fuel, allocation, positions and final variables.

Standalone sends and foreign Function Value calls without a Group adapter,
unlinked imported calls and standalone Object property calls without a Host
adapter stop at a
`Blocked` implementation boundary with the instruction and operands
untouched and no charge for that instruction. The pending Run remains visible
and a Request remains unsettled. A Decision remains open if it has not sealed
before that boundary. Group cancellation and Stop Script are supported as described
below. Segment-bound lifecycle is supported through participant hooks.
Snapshots retain preempted and suspended Runs, including their rollback bases.

## Save, restore and code updates

Public Run accounting is returned by Pump, Reload, Library replacement and Restore.
Dispatch/discard events precede cumulative Fuel and causal queue counts; observation
charges, detached sends and error Handlers are included without adding Trace records.

`Group.Save` returns opaque `go/5` bytes for a Quiescent Group. It retains the
Clock, sources and extensions, heap Values and closures, frames and rollback
bases, dispatch contexts and activations, owner identities, pending transfers,
cleanup progress and attempt counters, budgets and slice debt, ordered work and input queues, pending replies,
Decisions and Broadcasts, causal ancestry and accounting order, Objects and Grant state. It never starts work, drains
inputs or calls Host cleanup. Live scopes or participants, including unresolved
external effect state, refuse Save with `effects pending`.

`Core.Restore` rebuilds code and checks the saved Group Fingerprint against
current language/cost versions, Library identities, Grant declarations and
limits. Saves are specific to the Go Core family and format; corrupt or
unreadable bytes return `invalid save`. Formats `go/1` to `go/4` are no longer readable. Format `go/5` keeps stale
Function Values' names, arities and Declaration Documentation, and requires
causal accounting state as well as transfer references to belong to surviving dispatch contexts,
including after cancellation. Restore validates retained and active code/body/PC
references, shared owner-local layouts, phases, action arguments, cleanup tables
and acyclic ownership before rebuilding aliases. Native Object bindings, Host functions,
lifecycle hooks and Host futures are supplied again rather than serialized.
Missing Grant bindings become revoked; unresolved Objects become disposed.

A full restore returns pending Capability calls by Script, Run and call order.
Before its first accepted Pump, `Group.Settle` selects exactly one of `Answer`,
`Fail`, `Reissue` or `Adopt` for each id. Reissue calls the rebound Host
implementation with the original id and arguments, charges only additional Host
Fuel, and keeps the original deadline. Adopt returns a new Call into the restored
Group. Unsettled calls fail as `call lost` before due Timers on that first Pump.
Old Calls and Request/Decision futures still belong to the original Group.

`VariablesOnly` handles a readable mismatched save by carrying Script Variables
by name from the prospective rollback view. It preserves counters, Objects,
limits and revoked/disabled Grants, while discarding Runs, messages, Broadcasts
and slice debt without `finally`. It lists discarded work and abandoned calls;
open Decisions report `undecided` on the first Pump. Carried Function Values from
the replaced Script code are stale.

`Script.Extend` validates a new Entry against existing names and unrevoked
Grants. It appends new code, definitions and initialized variables atomically,
checking the Persistent State cap first. Existing frames, queues, Function
Values and code bindings remain live. Extension source order and identities
participate in the Script identity and Group Fingerprint. Reload and Library
replacement validate the complete replacement before stopping old work; failed
validation leaves existing execution intact.

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
their first blessings were approved on 2026-10-07 ([approval record](../../docs/reviews/milestone-one-blessings/README.md)).

`matching-fuel-exhaustion` and `pattern-size-made-at-run-time` pass with exact
exhaustion instructions, uncharged failing work and Segment rollback. A separate
step-4 gate protects the Text Pattern limits alongside all limit and cancellation
cases.
`pattern-size-literal-limit` also passes through Reload and snapshot replay.

## Group embedding

`New`, `NewGroup`, `Load`, Script/Group `Deliver`, `Request` and `Decide`, `Broadcast`, `DecideBroadcast`, `Pump`,
`Call`, `Inspect`, `Counters`, `Stop`, `CancelRun`, `RewindRun`, `Reload`, `Extend`,
`ReplaceLibrary`, `Save`, `Restore`, `Settle`, `Fingerprint` and `TraceSink` implement their handoff
signatures. Core compilation caches are mutex-protected and Groups have separate
live state. Load supports Scripts with named Capability Grants and an optional
Owning Object. Owners and well-known Objects are checked for Group ownership and
retained through Reload. Each live Object has at most one Owning Script. Other
unimplemented public declarations are omitted.

Any-goroutine deliveries reserve mailbox capacity before joining the input
queue. A Pump takes one Clock reading, drains accepted inputs in order, and
visits Scripts in load order, one Run per turn. Fuel Slice overrun becomes debt
on the next Pump; Fuel Cap limits the Group. Request cancellation joins the same
queue, and Pending results settle after Pump records. Worker reentry, backwards
Clock readings, invalid values and Function Values from other Groups are refused.
Clock readings outside the language's year 1–9999 range are refused with
`invalid value` before the Clock changes or queued inputs are drained. Refused
Pumps are traced at the call, ahead of those still-queued inputs.

`Script.Reload` checks and initializes new code against kept, unrevoked Grants
before discarding old work. A rejected Reload leaves calls and revocation state
intact. Successful Reload abandons scopes and pending calls without Script finally cleanup,
drops queued messages, settles Requests/reply senders as stopped, carries variables
by name when requested, and preserves counters. Carry uses the active Segment's
rollback base for preempted Runs; Function Values from the old code become stale.
A successful Reload restarts Script-addressed execution; a disposed owner
remains skipped by Object routing. Library replacement applies the same Reload
rules to every Script that imports a changed dependency, including extensions.

`Script.Stop` is queued and sticky. It discards running, parked and suspended
Runs without `finally`, rolls back an active Segment, and drops mailbox messages.
Waiting callers fail with `send failed`, reason `stopped`; open Decisions become
undecided with outcome `cancelled`. Stop reports list discarded Runs, dropped
Deliveries and abandoned calls. Pending Capability contexts are cancelled,
and open Capability Scopes receive automatic abandonment.
Owner disposal uses the same termination path with reason `owner disposed`.

Repeated Stops preserve the first reason and emit no additional Stop report
unless later accepted messages need dropping. Those messages still obey mailbox
admission limits. Broadcasts omit stopped Scripts. A Group whose Scripts are all
stopped pumps as `stopped`; Reload clears an ordinary Stop
state and reason. Fatal effect uncertainty stops the Group permanently.

Stops issued during Pump land at its next Host crossing or end, like `CancelRun`.
A crossing records its Host result, then the control input, before result
conversion. A refused Host Input made during a crossing also writes its input
and `refused` records there, in order with urgent controls; its API refusal remains
immediate. Independent Trace replay issues these inputs inside the recorded
property or Capability function, in ordinary and save/restore modes.
An interrupted current Run ends its Stretch as `stop` before the
Stop report, without a RunEnd or cleanup. Cancelling a crossing also skips
conversion of the discarded result; cleanup crossings retain their own charges.

### Function Value calls

A local Function Value call stays in the caller's Run. A foreign `f(x) and wait`
pays the ordinary call charge, enters the Home Script's FIFO mailbox, and starts
a concurrent Run without Handler Clause dispatch. It runs with the Home Script's
Grants and limits; captures and named defaults bind in its own code unit, including
imported functions. The caller's `MaxWait` bounds the reply. A plain foreign call
raises `would suspend`, a stale value raises `function gone`, and a full Home
mailbox raises `mailbox full` naming the Home Script. Failed admission creates
no call id or receiver Run.

Replies resume the caller in a new Segment without another call charge.
Receiver errors and limits become `send failed`; caller timeout or cancellation
abandons the reply while the Home Run continues. Inspection shows
`call-value-wait` with its pending id, and Function Runs and queued calls use the
Function Value's display label. Mailbox accounting retains the Function Value
and its captures, as well as arguments.

`Group.Call` admits a Host Function Value call like a Request, with Group and
argument validation and optional tighter Run limits. Staleness is checked when
inputs drain; a stale call fails `send failed`, reason `function gone`, without
a Run or Fuel. A live call's arity mismatch is an error at the body's first
instruction, before any execution charge or unwind. It cannot enter catch or
finally cleanup. Defaults and captures use the same binding as Script calls.
Context cancellation uses ordinary Delivery cancellation. A Host Function call
cancelled before dispatch has no Run id and spends no Fuel or allocation; its
Trace `run` record retains the Function Value's `fn` label.

The reviewed `functions/foreign-calls` and full `functions/host-calls` cases pass
unchanged, including Stop and stale Host calls. Full snapshots retain Function
metadata, captures, pending calls and internal sender/receiver pairs. Host Function
Values obtained from the original Group remain tied to that Group.

The Corpus runner reuses the latest Function handle received with a given
Display Form in Capability arguments, property writes, Run results and errors,
unhandled-message reports and inspection values, including nested Lists and
Maps. Host calls, message arguments, Capability Stub results and errors, and pending-call answers and
failures share that binding. Unknown Function handles are refused; declared
Objects reuse their registered handles. The reviewed
`functions/capability-callbacks` case passes unchanged and is required in the
Go passing gate.

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
identity. Data must be a Map or Nothing; other kinds and foreign Group values
become `host error`. Catalogue codes, reserved Data keys, undeclared codes,
invalid results, plain errors and panics also become `host error`, with Host-only
detail in `CallFailed`. Returned failures and queued `Call.Fail` inputs retain
Error maps in the Trace even when Data collides with the error envelope. Valid
Nothing/map failures retain their ordinary conversion costs and budget checks.
Calls carry the named Grant, binding, Pump Clock, Run and Segment identity.
Caught raises precede subsequent Host call records. Host inputs accepted during
a call join the next Pump; worker reentry is refused.

`Script.Grants` returns fresh, sorted Operation lists. `GrantsAsUsed` trims direct
uses across the whole Script, including unused function bodies. `Script.Revoke`
queues revocation in Host-input order; retained aliases remain independent.
Library needs participate in load/Reload validation and Grant trimming, including
private and transitive calls. Library Operations use the caller's binding and
ordinary Host crossing; compiled code retains only call metadata and declarations.

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
Ordinary calls have no scope and are not automatic. Immediate and
fire-and-forget calls carry a background Context. Segment-bound Operations use
`DefineSegmentCapability` or `DefineCoordinatedCapability` with synchronous
lifecycle hooks, described below.

### Segment-bound Operations

A Segment's participant is a Segment Coordinator, a `*SegmentLifecycle` with
synchronous `Begin`, `Commit` and `Rollback` hooks ([ADR 0069](../../docs/adr/0069-segment-bound-grants-share-a-participant-through-a-segment-coordinator.md)).
`DefineCoordinatedCapability` maps each binding to its coordinator once, when
the Grant is created; Load, Reload and Restore keep that pointer, and Grants
with the same pointer share a participant. `DefineSegmentCapability` takes one
`SegmentLifecycle` and gives each named Grant, aliases included, a coordinator
of its own. Segment-bound Operations must be immediate, and all lifecycle
Operations for a scope agree on their Segment-bound status. Hooks receive the
Group instance, Script, Run and Segment ids, last observed Clock, the first
enrolled Grant's name and binding, and every enrolled Grant in `Grants`. They spend no Script resources; reentrant
worker calls are refused. Hook results are `EffectOK`, `EffectFailed` or
`EffectUnknown`; a panic or malformed result is unknown, with Host detail kept
out of the Trace.

The first paid Segment-bound call enrolls its named Grant and calls `Begin`
before entering the Operation. A later call through another Grant on the same
coordinator enrolls it with no hook, while a Grant on another coordinator raises
`segment participant conflict`, naming the first enrolled Grant, before charging
or entering the Host. Preemption,
caught errors and empty Joins retain the participant. Completion and ordinary
errors commit after all boundary checks and scope abandonment; actual suspension
commits before its report or Verdict. Limit Faults, Stop, disposal and successful
Reload roll back. Cancellation first abandons every enrolled Grant's scopes
and rolls back, then runs finally cleanup in a new Segment with its own participant.

Failed abandonment on any enrolled Grant prevents commit and disables only that
Grant; an unrelated abandonment failure only disables its Grant. Definite non-commit restores the Segment's
Script Variables and ends `effect failed`, failing waiting senders without a
Limit Fault, Script catch/finally or an error Handler. Uncertain begin or commit,
and any unsuccessful rollback, stop every Script as `effect state unknown`.
Rollback is attempted once, and Load and Reload cannot revive this Group.
Successful commit finalizes before observing controls queued by its hook.

The runner passes all 30 effect cases unchanged, including Save refusal at live
participant boundaries and the four `effect-coordinator-*` cases for
ADR 0069 (first blessings approved on 2026-10-08), fatal Reload and Library replacement. A refused Save
performs no cleanup, drains no inputs and changes no execution state or counters.
Native tests also pin atomic replacement when a later Script's rollback fails.
The maintainer approved the first blessings of the original 22 effect cases on
2026-10-05; the
[step-4 approval record](../../docs/reviews/go-step-four-blessings/README.md)
records that review. The four remaining cases execute unchanged in the step-5 gate.
The runner gives Grants sharing a `case.toml` `coordinator` name one coordinator,
and each other Grant its own.

### Capability Scopes

Immediate Operations may declare `Scope` as `Opens` plus `Abandon`, or `Closes`.
Definition validates names, matching close targets, argument/result Shapes and
consistent abandonment targets. Grants containing an opener must include its
abandonment Operation; `GrantsAsUsed` keeps that dependency. Definitions copy
the metadata so later Host mutations do not change it.

Each Run owns separate slots by named Grant and scope name, including aliases
sharing a binding. Successful Host return acknowledges acquisition or closure
before result validation, conversion or queued interruption. Duplicate opens
and absent closes raise scope errors without calling the Host. Open scopes
prevent executed suspension boundaries and Join entry; local calls that never
suspend remain valid. Opening inside a Join is refused. These checks precede
instruction charges, while dispatch and ordinary unwind charges still apply.
Preemption retains the slots.

Completion, error, faults, cancellation, Stop, disposal and successful Reload
automatically abandon remaining scopes in reverse opening order before exposing
the outcome. Cancellation cleanup may still use scopes on ordinary Grants until
it ends. Automatic Calls use the saved implementation/binding even after
revocation, with `Automatic`, `ScopeName`, ownership ids, the last Pump Clock and
a fresh non-cancelled Context. They consume no Script Fuel or allocation and
cannot use `Charge`, `Answer` or `Fail`. Reentrant worker calls are refused.

Failed automatic abandonment reports `EffectFailure`, disables only that
Script's named Grant and continues remaining cleanup. Later calls raise
`capability disabled` before revocation checks. `Inspect` lists disabled Grant
names in sorted order; disabled state survives Reload and has no reset API.
Explicit close failures leave the scope open and usable.

All seventeen scope traces pass, including `scope-slots` and
`scope-suspension-boundaries` with corrected guard Fuel and allocation
expectations. Both Cores agree on the complete Traces; the
[charging reconciliation](../../docs/reviews/scope-guard-charging/README.md)
records the boundary audit. Their first blessings were approved for #141; see the
[approval record](../../docs/reviews/milestone-one-blessings/README.md). Disabled Grants survive full and variables-only restore;
Save refuses a preempted Run with live scope slots without abandoning them.

### Clock and Timer Standard Capabilities

`Core.ClockCapability(Costs)` supplies the fixed immediate `now` Operation. It
returns the Pump's Clock reading as an Instant, including nanoseconds, through
an ordinary named Grant. It never reads the Host's wall clock.

`Core.TimerCapability(TimerImpl, Costs)` supplies the fixed fire-and-forget
`schedule` and `cancel` Operations. The Host receives the caller's Call, name,
Instant, message text and data-only argument list. The Host stores timers by
Script and name, replaces repeated names, and delivers due messages with
`Script.Deliver`; the Core does not schedule durable timers itself. Arguments
are checked before costs or Host calls. Neither factory declares Script errors,
so Host failures become `host error`.

Each Operation requires its own `Costs` entry. Fuel and allocation must be whole
nonnegative safe integers; Go's zero-valued allocation means zero. Extra names
are ignored and costs are copied, so later map changes cannot affect calls.
Timer requires a non-nil implementation; an interface holding a nil pointer is
refused too.
Both factories use ordinary Grant trimming, Library needs and atomic charging.

### Console Standard Capability

`Core.ConsoleCapability(ConsoleImpl, Costs)` supplies fixed fire-and-forget
`write` and suspending `read` Operations. `write` forwards its Value to the Host,
including Function Values nested in Containers, and leaves `it` unchanged.
`say` calls `console.write` through the caller's Grant, including in Libraries.
Function Value display uses a Lambda's source unit and line/column, including
`<function session+N:L:C>` for a Session extension, with its captures when present.
Library Lambdas retain the Home Script and Library name. Internal enclosing
Handler names are not displayed.

The Host starts `read` with a Call and answers it with text without the line
break, including an empty line. Its fixed 2,147,483,647 ms timeout overrides
Script MaxWait. Answers queued during Read resume only in a later Pump;
timeout and cancellation abandon the Call and cancel its Context. Late answers
are traced and ignored. Both Operations retain the Script name and Grant
binding, require copied valid costs and a non-nil implementation, and declare
no Script error codes. Invalid read results and Host failures become `host error`.

### Store Standard Capability

`Core.StoreCapability(StoreImpl, Costs)` supplies immediate `get`, `set`,
`delete`, `keys`, `increment` and `swap`. The Grant binding names the Store.
The implementation is one Segment Coordinator for every binding, the same
pointer for every `StoreCapability` over one comparable implementation, so
writes to several Stores, or to one Store through several Grants, enroll in one
participant and use its `Begin`, `Commit` and `Rollback` hooks (ADR 0069). Shape checks precede empty-key checks;
`invalid key` is uncharged and never calls the Host. Results must meet each
Operation's Shape. Only declared Store catalogue failures with valid fields
pass through; malformed failures become `host error`.

`Add(a, b)` uses the machine's `+` rules without charging a Run, including
Quantity conversion and date arithmetic. It returns the same `*ScriptError`
and catalogue fields as Script addition. `increment` accepts number and
Quantity amounts at Load and at the Host crossing.

[`store.New(store.Quotas{...})`](store/) supplies named in-memory Stores,
starting empty. It keeps each live Segment's writes to every Store it writes,
in call order, applies a commit to all of them atomically, reserves keys against incompatible writes, and admits
concurrent increments without losing counts. Ownership includes Group identity
and Segment id. Quotas count logical key/value sizes and every Segment's
nonnegative net growth, so another Segment's rollback cannot free capacity
prematurely. This implementation provides no durable backend.

The Session Host builds in this Store with chapter 12's quotas: total size
1,048,576, 1,000 keys and largest value 65,536. `:grant scores store [name]`
binds `default` when no name is supplied. `:mock` refuses `store`. `get` and
`keys` cost 2 Fuel; writes cost 4, with no declared allocation. `:store` shows
committed entries in Unicode code-point order; `load`, `save` and `clear`
import, export and empty a named Store. Imports validate all contents before
replacement and record file contents inline in Transcripts. Store contents
outlive reload and remain outside saves and restores.

Run every language-neutral Store kit sequence with:

```sh
go -C impl/go run ./cmd/storekit
```

The same kit runs in `go -C impl/go test ./internal/storekit`, alongside native
cross-Group reservation, concurrent increment and Session Transcript tests.

### Calendar Standard Capability

`Core.CalendarCapability(CalendarImpl, Costs)` supplies the six fixed immediate
Operations: `today`, `now`, `toCivil`, `toInstant`, `offset` and `zone`. The Host
supplies timezone data and DST gap/overlap rules. Calls retain the caller's Grant
binding and Pump Clock, including through Library frames. Omitted or Nothing
zones are passed as `""` so the Host can use its binding's default; the Trace
retains the supplied argument list.

`toInstant` requires a date-time. With two arguments, the second text is a
recognized disambiguation or a zone; with three, the second is a disambiguation
and the third a zone. Omitted or Nothing disambiguation defaults to `compatible`.
Domain checks follow Shape checks and precede charges and the Host crossing.
Results are checked before conversion: `today` is date-only, `now` and `toCivil`
include time, `toInstant` is an Instant, `offset` has exact Unit `s`, and `zone`
is text. Invalid results become `host error`.

Each Operation declares `unknown zone` with text `zone`; `toInstant` also declares
`ambiguous time` with Civil Date `civil` and text `zone`. These catalogue failures
are accepted only with valid fields and no reserved Data keys. Other Host
failures become `host error`. The factory requires all six copied costs and a
non-nil implementation. Factory checks are private to the definition; ordinary
Capabilities cannot opt into Calendar errors by name or declaration.

### Locale Standard Capability

`Core.LocaleCapability(LocaleImpl, Costs)` supplies eight fixed immediate
Operations: `compare`, `rank`, `upper`, `lower`, `numberSymbols`, `monthNames`,
`dayNames` and `tag`. The Host supplies Collation, case mappings, Locale data and
supported-tag lookup/fallback. The Grant binding supplies a default tag string;
calls retain the caller's binding and Pump Clock through Library frames.

Optional options and tag arguments are distinguished by kind. Omitted or Nothing
options receive a complete map in documented key order: `sensitivity: "variant"`
and `numeric: false`, or `width: "long"` and `form: "format"`. An omitted or
Nothing tag reaches the Host as `""`. The Trace retains supplied arguments.
Shape checks precede option-domain checks in supplied map order, then effective
tag validation, all before charges and Host execution. An explicit tag overrides
a malformed default. The Core checks case-insensitive ASCII RFC 5646 syntax,
including private-use and grandfathered tags, without registry checks, trimming
or canonicalisation. Malformed tags raise `bad locale`; invalid option words or
text in both optional positions raise `out of domain`.

Result checks require `compare` to be exactly -1, 0 or 1, `rank` to contain exactly
the distinct supplied texts with dense positive integer ranks, name lists to
contain 12 or 7 texts, and `numberSymbols` to be a closed map with nonempty
separators/signs, ten nonempty digit texts and positive integer grouping fields.
`tag` must return well-formed tag text; case results are text with Core-owned NFC.
Invalid results and every Host failure become `host error`. All eight costs are
required and copied; the implementation must be non-nil.

### Host Object handles, properties and disposal

`Core.DefineObjectKind(ObjectKindDef)` validates and copies a reusable declaration,
including property Shapes, callbacks and safe costs. `Group.Object(kind, id,
native)` registers a Group-scoped handle. Kind/id pairs are unique within the
Group, even after disposal; different kinds and different Groups may reuse an
id. Native state stays on the Host side. Well-known `LoadOptions.Objects`
bindings are copied, checked for Group ownership and preserved through Reload.
Host calls and Capability results accept registered handles, including nested
containers, and refuse foreign handles.

`Group.Dispose` queues an idempotent Host Input applied before turns at the next
Pump. It may be called from any goroutine or a Host callback. `objectKind(o)`,
`isDisposed(o)` and `the id of o` are Core-owned and usable in Guards. Disposal
changes only lifecycle state: identity, equality, id, kind and Value Encoding
remain available. Atomic lifecycle state permits concurrent metadata reads.
Every accepted disposal input notifies `OnReady` after releasing the queue lock.

`the k of o`, quoted and computed keys invoke a declared property's `Get`;
`set` invokes `Set` after checking the input Shape. A missing key reads Nothing;
a missing or read-only setter raises `read only`. A Shape mismatch precedes the
Host call and its charges. Instruction Fuel and declared Fuel/allocation are
paid atomically before the callback. Get results and custom failure Data are
validated for Shape or error-contract compliance and Group ownership, then
charged for conversion. Panics, invalid results and malformed failures raise
`host error` with the Object Kind and property names; Host detail stays in a
`CallFailed` report with an empty Call id, since properties have no call id.
Each actual call writes a `prop` record before later raises or cancellation.
If Stop or a newly landed cancellation interrupts the Run at that crossing,
the property failure raises no `host error` and emits no `CallFailed` report.
Failures in property calls made during cancellation's finally cleanup still
raise and report normally.
Host effects survive later conversion faults or Script Segment rollback.

Outside Guards, disposed handles reject every non-id key read, including missing
keys, and every property write with `object gone`. Identity inspection remains available.
Property callbacks may queue ordinary Host inputs; these wait for the next
Pump, while `CancelRun` may land at the crossing and run finally cleanup.

Guards reject known Object non-id keys at Load, including computed keys unless
they are the Text literal `id`. Parentheses preserve known roots and literal keys.
A dynamic Guard reads map keys or the Core-held Object `id`; other Object keys
raise `wrong kind` (expected map), charge the ordinary key instruction and skip
the Guard clause without calling the Host. This also applies after disposal.
Missing or read-only setters reached through dynamic keys or aliases still raise
`read only` at runtime. Literal writes through `me` also use the owner
Kind metadata at Load and Reload.

### Object Message Paths

`SetParent` queues parent changes and rejects known cycles and disposed children.
Changes that become invalid while queued, including children unresolved by Restore, leave the parent unchanged, write `refused`, and report a `*HostError` in the next Pump. Later inputs still drain; the report code is covered by parity and its detail is Host-only.
`ParentKinds` remains manifest metadata. Disposal preserves Object identity,
stops its owning Script without finally cleanup, and routing skips to its parent.
Later Script-addressed deliveries are accepted and dropped under the same Stop
reason; Requests fail as stopped and open Decisions become undecided.

Object-addressed Deliveries, Requests and Decisions route to the nearest live
Owning Script. Accepted messages retain admission when a preceding parent input
changes their receiver. Dispatch checks the current path before message
observation or creating a Run; a moved message joins its new mailbox tail,
even beyond depth, without Fuel. An unowned path ends with Unhandled and zero
Fuel. Started, preempted and parked Runs stay in their Script.

`me` is the owner or Nothing; `the target` remains the initially addressed Object,
or the initially addressed Script's owner. `pass` and unmatched messages climb
from the last owner's current parent, checking capacity for the climb. Pending
Requests, waiting sends and open Decisions continue with the same ids. A full
climb emits `climb-full` and ends unhandled. Every receiver applies its own limits,
with Host overrides as additional caps.

Script sends accept Objects, named Scripts and `me`. Unknown Command Calls send
from the owner's parent; their `and wait` forms await the final receiver. At the
end of a path, waiting senders fail with `send failed`, reason `unhandled`.
The eight reviewed Message Path, Decision and owner-disposal corpus cases pin
exact costs, movement order, Targets, Stop reports and Verdicts.

### Scheduling and suspension

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
`CancelRun` also queues cancellation and may land during a Pump at a Host crossing
or Pump end; ordinary settlements still wait for the next Pump. `RewindRun` lands
the same way: a Run that hasn't passed a Suspension Point (its saved
`SuspendedOnce` is false) is rolled back, discarded with reason `rewind`, and its
message put back at the head of the mailbox, and the Pump returns `Rewound`.
`Reload` with `ReloadOptions{KeepMailbox: true}` keeps that mailbox (ADR 0068).
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
and other non-Object filters raise `wrong kind`. Object filters compare the
Delivery's fixed Target; moved messages are observed only by the receiving Script.

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
Foreign Function Value calls use the Home Script mailbox and the same reply
mechanism; see [Function Value calls](#function-value-calls).

`wait for all … end` supports ordinary Capability calls and waiting sends to named
Scripts, Host Objects and `me`, including mixed Joins. Each member starts where
reached, leaves `it` unchanged, and receives a call id in start order. The closing `end` suspends once; its ready resumption
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
with `can't suspend here`. A call cannot hide a nested Join.
Join failures and timeouts use the closing `end` token's source position,
for bare `end` and `end wait`, including Joins in local Handlers and block
Lambdas. The `join-end` PC and 1-based member `index` stay unchanged; a failed
reply retains the receiver's own Error map and source position.
Lambda Errors name their enclosing Handler or function in `at.handler`, while
the generated body-table identities and PCs remain unchanged. Function Value
sizes count captured Values; the `items` measure is zero for a Function Value,
as Cost Model 0 specifies. `errors/lambda-capture-parity` agrees on Go, TS and
TS save/restore for captured Join failures/timeouts and nested Lambdas. The
maintainer approved its first blessing on 2026-10-05 and a later correction on
2026-10-07; see the [step-3 approval record](../../docs/reviews/step-three-blessings/README.md).

Decisions expose a `Deciding` future and a `Decided` report. An
ordinary Handler allows after its successful dispatch charge; an unmatched
message also allows. A matching pending wait allows a Decision before Handler
dispatch. A deciding Handler keeps its Verdict open through
preemption until its first Segment ends or suspends, sealing `Allowed`, or
until `veto` completes its finally cleanup, sealing `Vetoed` with its reason.
The vetoed Run completes with Nothing. Errors, faults, drops and cancellation
before sealing report `Undecided` with the Run's outcome. Reports appear at
the seal, and futures settle after the Pump's records. Context cancellation
after sealing leaves the continuing Run alone. The corpus runner replays
`cancel-delivery` by cancelling the context passed to the public Request,
Decision or Function Value call, waiting for `OnReady` before its next input.
The complete Decision cancellation and Host Function Value cancellation cases
pin mailbox removal, Verdicts, cleanup and exact costs. Native runner tests
also abort a sealed Decision and require no queued input or cancellation.
Load checks reject vetoes
outside deciding entry Handlers, in locally called Handlers, or reachable
after suspension, and reject passes reachable after suspension. Open Decisions
follow Message Paths through `pass` and unmatched Runs.
For a Script with no owner, `pass` completes its Run and reaches the end of the
path, reporting `unhandled` and allowing an open Decision; Requests fail with
`send failed`, reason `unhandled`.

`Group.Broadcast` and `Group.DecideBroadcast` choose recipients when inputs
drain, in Script load order: a Handler or a pending message wait makes a Script
interested. Scripts loaded after the call can participate; earlier queued
disposal or cancellation removes stopped Scripts or cancelled waits. Each
recipient gets a Delivery id and its owner's Target. Broadcasts never climb
Message Paths or emit an `unhandled` report, including after `pass`.

Broadcast admission checks arguments and limit overrides against the Core's
defaults. Each recipient keeps the tighter of its own limits and the override.
Recipients join FIFO mailboxes even past capacity, since they are unknown at
admission. Runs and start Segments carry the Broadcast id.

A Broadcast Decision settles after every recipient seals. Any veto wins over
undecided outcomes, which win over allowed; an empty Broadcast is allowed.
Vetoes and undecided outcomes retain recipient order across Fuel Slices. Context
cancellation removes or cancels only recipients with an open Verdict; already
sealed Runs continue. Reload and disposal settle only the affected recipients.
The two reviewed Broadcast Decision cases and full
`cancellation/broadcast-recipients` case pass unchanged, including prior Stop
inputs. Snapshots preserve shared Broadcast Decision state and recipient order;
variables-only restore queues discarded open Verdicts for its first Pump.

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

`--check-passing` runs the complete Corpus and fails on any case that does not
pass, listed or not, and on a listed case that no longer exists. Each failure
ends with a `reproduce:` command. The list contains 307 cases, including all text-model, load-diagnostic,
Disassembly and Value Encoding acceptance cases, plus reviewed scheduling,
error, Decision, Capability, Library and Standard Library traces. Trace cases replay through the
public embedding interface, with exact records, costs and final state. All three
Counters cases are protected in ordinary and save/restore replay.
`counters/faults-and-cleanup` uses a public Request context for queued cancellation;
it starts no Run and charges no Fuel. Its corrected input was approved on
2026-10-07 ([approval record](../../docs/reviews/milestone-one-blessings/README.md)); see the [Spec derivation](../../docs/reviews/delivery-cancellation/README.md#queued-request-cancellation-correction-364).
Tests separately enforce the full 62-case step-1 set, eight reviewed step-2 cases, 32 step-4
limit/cancellation/Text Pattern cases, all 30 Segment-bound effect cases, and
18 step-5 save/restore, Extend and replacement cases, and all twelve Session
Transcripts, so removing a required case cannot silently
shrink the gate. Five reviewed Core-error cases also pin retained error-map
sizes, and two new error-delivery regressions agree on both Cores. Four
reviewed wait cases pin zero waits, deadlines, rollback and nested frames.
Two new suspension regressions also agree on both Cores, covering work ordering,
cap-held resumptions, nanosecond rounding and long durations. The maintainer
approved the first blessings of these four regressions on 2026-10-05; see the
[step-3 approval record](../../docs/reviews/step-three-blessings/README.md). The reviewed Queueing Policy case also passes; two new
policy regressions agree on both Cores before blessing, covering selected
clauses, Guard skips, preemption, and dispatch and Persistent State limits.
The maintainer approved both policy regressions for #135 on 2026-10-05.
Listing an unreviewed regression case here protects it while its first human
blessing review remains pending.
Three reviewed Decision cases pin errors, faults and preemption before sealing.
A new Decision regression agrees on both Cores, and its first blessing was
approved on 2026-10-05; it covers dispatch charges, dropping, veto
cleanup, unmatched messages and a Run that resumes after its Verdict seals.
Four observation traces reproduce the corrected event-test charge on both Cores,
including atomic cap/slice overruns, debt, late Run faults and Decision sealing.
A new observation regression also agrees on both Cores, and its first blessing
was approved on 2026-10-05; it covers pinned locals, live Script Variables,
branch priority, Guard errors, non-consuming matches, sender filters, timeouts
and internal error observation. The reviewed `suspension/wait-for` case now
agrees on Go, including Script sends and sender filters. Three new send regressions
agree on both Cores; `limits/self-send-persistent` was approved for #135 on
2026-10-05, and the two suspension cases' first blessings were approved on
2026-10-05, with a later `suspension/script-sends` correction approved on 2026-10-07.
They pin FIFO and self sends, full/missing/invalid receiver errors, record order,
immediate delivery surviving a sender error, and preempted receiver identity
without Value size, and same-Segment Persistent State checks after self-send.
The corrected `decisions/broadcast-outcomes` and `objects/wait-target` Traces
also agree on Go after Broadcast Decisions and Object Message Paths were added.
`reload/extend-units` passes unchanged, including old Function Values after
Extend. The nine-case event-test acceptance set requires all eight corrected
Traces and the observation regression in the passing gate, with exact ordinary
and save/restore replay. The [charging reconciliation](../../docs/reviews/event-test-charging/README.md)
records their complete parity verification. Every supported Trace also runs
with Save/Restore between Pumps,
subject to chapter 11's exclusions for old Host handles. Live effects require an
`effects pending` refusal with unchanged inspection and counters before replay
continues on the original Group.

The reviewed `suspension/send-and-wait` Trace also passes unchanged, with replies,
receiver errors, unmatched messages and timeout. Three new paired reply cases
pin resumption unwinding under a Pump cap, pending-call retention faults, and
replacement cancellation with cleanup and ignored late replies.
`limits/send-wait-retention` was approved for #135 on 2026-10-05; the two
suspension cases' first blessings were approved on 2026-10-05, with a later
`suspension/send-reply-preemption` correction approved on 2026-10-07; see the
[step-3 approval record](../../docs/reviews/step-three-blessings/README.md).

Six reviewed ordinary Capability cases and `limits/mailbox-depth` pass unchanged: calls, argument Shapes,
load checks, Host failures, charge faults and omitted optional arguments.
Two new cases agree on Go, TS and TS save/restore before blessing:
`capabilities/declared-allocation` pins atomic pre-Host charging in both modes;
`capabilities/ordinary-grants` pins alias bindings, revocation, trimming and caught
raises before later Host calls. Their first blessings were approved on
2026-10-05, with a later `ordinary-grants` correction approved on 2026-10-07;
see the [step-3 approval record](../../docs/reviews/step-three-blessings/README.md).

Under `--check-passing`, any failing or unsupported case fails, as does a listed
case that no longer exists; an unlisted passing case is reported for addition.
A plain run reports `SKIP` with a reason for unsupported facilities, and
explicitly selecting an unsupported case fails.
Session Transcripts reproduce their existing output and `case.trace` unchanged.
The `sessions/extension-lambdas` regression covers extension Lambdas with and
without captures, calls and display after Save/Restore; its first-blessing review
is pending in the [review record](../../docs/reviews/extension-lambdas/README.md).
The original nine first blessings were reviewed under [#131](https://github.com/odogono/odgn-talk/issues/131#issuecomment-5957819419);
the later `fenced-text` Transcript was approved on 2026-10-05; see the
[fenced-text approval record](../../docs/reviews/fenced-text-blessings/README.md).
Each emitted Trace also replays independently through the public embedding API,
both ordinarily and with Save/Restore between Pumps. Save/Restore replay is part
of the Trace backend. The Go runner has no blessing mode and never changes expected
Corpus lines.

Six reviewed Library-related cases pass unchanged: `libraries/calls`,
`libraries/errors`, `libraries/registration`, `stdlib/calls`,
`stdlib/errors-name-the-call` and `builtins/function-values`. A separate
acceptance test requires all six in the gate.

The new `stdlib/template-migration` regression also agrees on Go, TS and
TS save/restore, and is required in that gate. Its first blessing was approved
by the maintainer on 2026-10-05 for #275; see the
[fenced-text approval record](../../docs/reviews/fenced-text-blessings/README.md).

Three reviewed Library Capability cases also pass unchanged: `libraries/needs-transitive`,
`libraries/needs-suspending` and `capabilities/optional-args`. The new
`libraries/caller-capabilities` regression agrees on Go, TS ordinary execution
and TS save/restore. Its first blessing was approved on 2026-10-05, with a later
correction approved on 2026-10-07; see the [step-3 approval record](../../docs/reviews/step-three-blessings/README.md). It
pins private/transitive needs, caller calls and charges, nested suspension,
Library cancellation cleanup, late answers and revocation. A separate acceptance
test requires all four in the gate.

Three reviewed Standard Capability cases pass unchanged: `standard-clock`,
`standard-clock-fuel` and `standard-timer` under `capabilities/`. A separate
acceptance test requires them in the gate, pinning nanosecond readings through
Library calls, declared cost rollback, Timer Host charges and ordinary Deliveries.

The reviewed `standard-console`, `standard-console-timeout` and
`standard-console-cancel` traces also pass unchanged, including nested Function
Values, Library Grants, starting/late costs, the fixed timeout and abandonment.
The reviewed `reload/function-staleness` trace passes with corrected Function
Value display. A separate acceptance test requires all four cases in the gate.

Three reviewed Calendar cases pass unchanged: `standard-calendar`,
`standard-calendar-errors` and `standard-calendar-validation` under
`capabilities/`. A required-case acceptance test protects all three, including
optional arguments, declared failure fields, uncharged domain errors, malformed
results and exact costs.

Three reviewed Locale cases pass unchanged: `standard-locale`,
`standard-locale-ranks` and `standard-locale-validation` under `capabilities/`.
A required-case acceptance test protects all eight Operations, dense-rank
sorting, option/tag validation, malformed answers and exact charges.

The reviewed `builtins/object-kind` and `builtins/kind-of` cases pass unchanged
through public Object registration, well-known bindings and queued disposal.
A required-case acceptance test protects kind inspection for all Value kinds,
identity and Guard behavior across Object kinds that share an id and after
disposal, including exact Fuel, allocation and persistent state.

The corrected `objects/properties` fixture uses a local alias for its runtime
read-only write; Get/Set ordering, declared and conversion costs, Shape errors,
missing keys and disposal remain covered. Its added alias costs two Fuel and
shifts later instruction and source positions. New `load-diagnostics/object-properties`
and `objects/guard-keys` cases pin Load diagnostics, map keys, live/disposed Object
Guard skips and Core ids. Both Cores agree on every record and cost before
recording expectations. Their first blessings were approved on 2026-10-05, with
a later `objects/properties` correction approved on 2026-10-07 (see the
[step-3 approval record](../../docs/reviews/step-three-blessings/README.md)), and required-case tests protect them in the Go gate.

The `capabilities/standard-store*` cases pass in ordinary and save/restore
replay and are required in the Go passing gate. Three keep their
[first-blessing approval](../../docs/reviews/store-blessings/README.md);
`standard-store-segments`, changed for #461, and the new
`standard-store-coordinator` await review. That review remains separate from
the memory Store's 32 store-kit sequences.
