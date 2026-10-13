# Zig Core

The Zig Core is a third NorthTalk Core for embedding outside Go and TS: natively
through the C API in [`include/talk.h`](include/talk.h), and as a `wasm32-wasi`
module for Hosts with a WASM runtime
([ADR 0078](../../docs/adr/0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md)).
It is written from the Spec, its Data Files and the Conformance Corpus, never
translated from the Go or TS Core
([ADR 0071](../../docs/adr/0071-a-third-core-serves-embedding-outside-go-and-ts-after-the-message-layer-is-measured.md),
[ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)). The
design decisions that bind it are recorded on
[#625](https://github.com/odogono/odgn-talk/issues/625#issuecomment-6111271797).

It is under construction, step by step through
[Appendix B](../../spec/appendix-b-implementation-order.md). So far it has its
generated tables, Unicode text primitives, reference-counted values, native
decimal arithmetic, the display form, the Value Encoding, a corpus runner, and
the front end's lexer, lossless parser, checker and lowering, and the first
part of the Abstract Machine, driven through `talk.h`.

Use the [Zig task map](NAVIGATION.md) for implementation files, Spec links,
tests and check commands.

## Layout

- `build.zig`, `build.zig.zon`: one Zig package, `northtalk`, pinned to Zig
  0.17.0 by `minimum_zig_version`. It uses Zig's standard library only: no
  third-party packages and no linked C libraries.
- `include/talk.h`: the C API. It mirrors
  [`spec/embedding/talk.go`](../../spec/embedding/talk.go)'s names in C style,
  as [`tools/zig/api.ts`](../../tools/zig/api.ts) spells them, and declares only
  what the Core implements.
- `src/root.zig`: the package root. [`src/talk.zig`](src/talk.zig) holds
  `talk.h`'s exports.
- `src/unicode/`: UTF-8, NFC, Characters (extended grapheme clusters), simple
  case folding, and the `word` and `word break` rules, built only on the
  generated tables.
- `src/generated/`: tables written from the Data Files and the pinned Unicode
  data. Never edit them by hand.
- `src/decimal/`: chapter 3 decimals and exact rational arithmetic.
- `src/value.zig`, `src/units.zig`, `src/dates.zig`: immutable values,
  copy-on-write containers, catalogue Units and Gregorian dates.
- `src/display.zig`, `src/encoding.zig`, `src/pattern.zig`: the display reader
  and writer, lossless Value Encoding and canonical Pattern source reader.
- `src/syntax/`: the modal lexer of chapter 1 and the predictive parser of
  chapter 2, which builds a lossless syntax tree.
- `src/check/`: the checker, which raises chapter 2's load-time diagnostics
  and resolves the names the lowering reads.
- `src/lower/`: the normative lowering of chapter 8 to `machine.toml`'s
  instructions, and the canonical disassembly.
- `src/corpus/`: case discovery, metadata, encoding replay, Trace parsing,
  case setup and Disassembly Cases.
- `src/machine/`: the Abstract Machine: Groups, Scripts, Runs and frames,
  the run loop, Cost Model 0 charging, chunks and properties, the Built-ins it
  has so far, and Trace writing.
- `tests/`: C programs that use `talk.h` as a Host would.

`session` and the REPL join `src/` in step 6.

## Syntax

The parser drives the lexer: it names the mode of every token it asks for,
reads at most two tokens ahead for the decisions `grammar.toml` lists, and
stops at the first syntax error with its code and position. A lexical error
comes back as an `invalid` token, so a parser that has peeked past the token
it fails at still reports that one. Fenced text is scanned whole when its
opener is lexed, holes and nested literals included, and each literal is
remembered by its offset, so nested interpolation stays linear. Margins,
escapes and line breaks are decoded then; NFC is left to the value.

Every token, line breaks and the end of the source included, is kept in
source order, and a backtick literal with holes is split into pieces around
its holes' tokens. `Tree.reconstruct` rebuilds the source byte for byte from
them. The tree's shape is the Zig Core's own.

Source nesting is bounded at 128 recursive parser regions, and an expression
tree at 128 levels, so hostile source ends in `source nesting too deep`, never
a stack overflow. Like the Go Core's limit, that code is an implementation
limit outside the Spec's catalogue.

## Checking

`check.check` takes a parsed unit and a `Context`: whether it is a Library,
the well-known objects, the Script's Grants and the Group's Libraries. It
returns every load-time diagnostic, ordered by position and then by
`diagnostics.toml`'s order, with what each Name refers to, each body's locals
and captures, and which Handlers may suspend. `check.exports` gives what a
checked Library exports to its importers. The stdlib Libraries' exports and
the Built-ins come from `stdlib.toml`.

A Handler may suspend when a clause holds a written Suspension Point, or a
Command Call to a Handler that may, found over the call graph to a fixpoint.
That decides `missing and wait`, `needless and wait` and `can't suspend here`.
A `, deciding` Handler's `veto` and `pass` are checked over every path through
its body for `after a suspension`.

Capability calls, `say` included, are checked only when the `Context` gives
the Grants, `wrong argument` among them for a literal against an Operation's
Shape. The checker also records each call as a Library's `needs`, which a
Script's load checks against its Grants for `missing grant`. Loading raises two
diagnostics after the checker: `pattern too large` for a Text Pattern literal
whose compiled program, every copy of a counted repetition counted, runs past
the default `patternSize`, and `initialiser failed` at the instruction where a
unit's initialiser raises, which leaves no Script in the Group, or no compiled
Library. `import cycle` is never raised: `talk_compile_library` takes a
Library's imports already compiled, so a cycle can't be built.

## Lowering

`lower.lower` turns a unit that checks clean into a code unit: its constant
pool, definitions, variables, objects, body table, code, Unwind Table, offer
records and event table, each instruction with its source position.
`lower.disassemble` prints its canonical disassembly. The in-memory
instructions are the Zig Core's own (ADR 0009), and nothing outside `src/`
depends on them.

Each body is lowered into its own buffer, with labels local to it, and the
buffers are laid out in body order at the end. A Lambda or an event test is
numbered and lowered where the lowering reaches it, so its constants and
nested bodies are numbered there too. Temps take the lowest free slot; a catch
handler's dispatch slots start above every slot the protected body used.
Every inlined copy of a `finally` block, and the exit after it, is cut out of
the spans of the `try`s it leaves, so an entry split by copies becomes one
entry per span. The Operation modes that pick `ask`, `ask-wait`, `join-ask`
or `tell` come from the Context's Grants.

## Building and testing

Run these from `impl/zig/`, after `bun install --frozen-lockfile` and
`bun run unicode:check` at the repository root. The Unicode check downloads and
verifies the pinned UCD files the tests read.

```sh
zig build test                    # the Zig tests and the talk.h C tests
zig build                         # zig-out/lib/libtalk.a and zig-out/include/talk.h
zig build -Dtarget=wasm32-wasi    # zig-out/bin/talk.wasm
zig build corpus -- --check-passing
zig build corpus -- --list
zig build corpus -- bytes/value-encoding
zig fmt --check .
```

Every build is `-Doptimize=safe` (ReleaseSafe) unless told otherwise, so bounds
and integer overflow stay checked while the Core reads hostile input.
`-Doptimize=fast` is refused.

Zig 0.17 renamed standard library APIs that older examples and documentation
still use. Check names against the installed source, under `lib_dir` from
`zig env`, rather than online docs:

- `std.builtin` is an alias for `std.lang`, defined in `std/lang.zig`.
- Optimize modes are `debug`, `safe`, `fast` and `small`, so the flags are
  `-Doptimize=safe` and so on.
- `std.testing.refAllDeclsRecursive` is gone; use `refAllDecls` per container.
- `@typeInfo` of an enum gives `field_names` and `field_values`, not `fields`.

The `wasm32-wasi` target builds a WASI reactor: a module with no `_start` that
exports `talk.h`'s functions. A Host instantiates it once per instance and calls
the exports directly, passing structs and text through `talk_alloc` and
`talk_free`. It is stripped of debug sections and has a 1 MiB stack, since the
stack sits in linear memory and nothing recurses past the depth guards.
[`tools/wasi/zig.py`](../../tools/wasi/zig.py) runs it in wasmtime and holds its
memory per instance and payload to #532's thresholds, in CI; the [first
figures](../../docs/research/zig-wasi-figures.md) are 2 MiB per instance and
0.40 MiB of Brotli payload, against the Go reactor's 15.5 and 2.04.

From the repository root, `bun tools/zig/api.ts` compares `talk.h` with
`talk.go`. It fails on a `talk.h` name that `talk.go` doesn't declare, unless
the declaration is marked `C only`, and lists the `talk.go` names `talk.h`
doesn't declare yet. Those fail only from step 6's conformance gate.

## The machine

`talk_new`, `talk_new_group`, `talk_load`, `talk_script_deliver`,
`talk_script_request`, `talk_pending_result`, `talk_pump`, `talk_inspect` and
`talk_script_counters` drive a Group. A Group's Trace reaches the Host's `talk_trace_sink` one line at
a time. Loading a Script parses, checks and lowers it, runs its initialiser
uncharged and writes its `load` record with its code identity, or its `diag`
records and `TALK_LOAD_REFUSED`. Limits and Fuel Slices aren't reachable
through `talk.h` yet.

Each Group allocates everything it holds through its own allocator
([Group allocator](src/machine/group_allocator.zig)), which wraps the
`talk_allocator` the Host gives in `talk_group_options`, or the Core's, and
counts physical bytes against `memory_cap` (256 MiB by default). Cost Model 0
still charges logical allocation; the cap is for defects. A refused
allocation becomes `TALK_OUT_OF_MEMORY`: the Run in flight is dropped whole,
messages and waits that couldn't be queued are released, and the Group takes
no more work, while `talk_group_release` still gives back every byte.
`talk_group_memory` reports the bytes held, the peak, the cap and whether a
refusal happened. A test refuses at every allocation of a run of Scripts with
sends, Joins, `wait for`, errors and `finally`, and checks that nothing is
left.

A Pump writes and drains the queued Deliveries and Requests, then runs each
Script's mailbox: each Run tries its Handler's clauses in order, charging the
`clause` rate at each clause's first instruction. A Command Call to a Handler
of the Script, with or without `and wait`, tries its clauses the same way in a
new frame, and raises `no match` at the call when none takes it. A message no
named clause takes goes to the Fallback's clauses with its `{name, args}` map,
built without charge, unless it is an `error` message; its Run's records add
`fallback=yes`. A clause's Queueing Policy applies once its patterns and Guard
have passed, while a Run of the clause hasn't ended. `, queued` parks the new Run after its `clause` charge, and the
first parked Run becomes ready when the clause's Run ends, behind any `error`
message. `, dropping` ends the new Run `dropped`. `, replacing` cancels the
earlier Runs: what each waits on is abandoned at once, and in its own turn it
runs its `finally` blocks, innermost first, with nothing unwound, and ends
`cancelled`. A waiting sender gets `send failed` with that reason.

A Decision (`talk_decide`, `talk_script_decide`) is a Delivery that carries
an open Verdict. A `wait for` that takes it allows it, and so does a selected
clause without `, deciding`; a selected `, deciding` clause holds it. The
Verdict is sealed at the end of that Run's first Segment, with a `decided`
record after its `seg`: `veto` vetoes it, and suspending or ending without one
allows it. `pass` carries it up the Message Path, and the end of the path
allows it. A Run that errors, faults or ends `effect failed` first, or a
`, dropping` clause that drops it, leaves it undecided, after the `run`
record. A Delivery, Request or Decision whose name has a `:` but isn't a
Selector with one argument per part is refused at the call, with its `>`
line, no id, and `refused code="invalid value"`. `cancel-delivery` comes
with cancellation.

A Broadcast (`talk_broadcast`) or Broadcast Decision (`talk_decide_broadcast`)
finds its recipients when the queue is drained: the Scripts with a Handler
for the message or a `wait for` pending on it, in load order, each with its
own delivery id, which the `>` line lists. A recipient's Delivery carries the
broadcast id, never climbs, never reaches a Fallback and is never
`unhandled`; neither does a Decision's. A Broadcast Decision gathers each
recipient's part, its veto, its undecided outcome or its allowing, and writes
one `decided` record once the last has one: vetoed if any vetoed, undecided
if none did but one was undecided, and allowed otherwise, at once when there
are no recipients. Frames are on the heap, so
the run loop never recurses on Script depth. Every instruction is charged by
its `machine.toml` cost key, or `builtin.<name>`, from the generated Cost Model
0 terms, with `scanned` reported by the operation itself, and Persistent State
is measured over the Script Variables and the mailbox at a Segment's end.
`talk_script_counters` reads a Script's lifetime Fuel, allocation, Runs and
Limit Faults, live Runs included, with its current Persistent State and
mailbox, and writes the `counters` record without draining Host Inputs.

So far the machine runs straight-line code, branches, loops, functions, chunks
and properties, keys, lists and maps, `match` with its destructuring tests,
Bytes builds and Binary Patterns, `as` conversions, number, Quantity and date
arithmetic, `^`, and the Built-ins. `floor`,
`ceiling`, `truncate` and `round` round the coefficient exactly by the General
Decimal Arithmetic's modes; `upper` and `lower` use the full case mappings, with
Final_Sigma, then NFC; the date fields, ISO weeks, `toCivil` and `toInstant`
work on proleptic Gregorian days; and the float Built-ins read and write IEEE
754 bytes through the shortest round-trip decimal. `sqrt` and `power` are the
decimal `power`, exact where the value is. `exp`, `ln`, `log10` and the
trigonometric functions ([transcendental](src/decimal/transcendental.zig))
bound the exact value in a fixed-point interval, with pi by Machin's formula
and each series' tail bounded, and round both ends; by Ziv's method, a
disagreement retries with twice the guard bits. A Built-in that raises still
pays its rate. A
raised error unwinds in two phases: the catch search walks the Unwind Table
outward, charging `unwind` per frame it leaves and running each catch test in
a dispatch activation over the owner's locals, then the exited `finally`
blocks run, innermost first. A Run keeps its error control as a stack of
dispatches and cleanups, so a catch's tests and a Recovery policy run in the
ordinary run loop and may call functions; the failed frames above the owner
are held aside meanwhile. An error inside a policy, or inside a `finally`
block a cleanup is running, first searches only inside it, then escapes as
chapter 6 says: an escaping policy runs its own and the failure's `finally`
blocks and goes on outward from the catching `try`, past its other catches,
from where the policy failed. `choose-offer` looks the name up in the failure
chain, charging `4 * frames` for the frames it scans, and transfers after the
policy's `finally` blocks and then the failure's down to the offering `try`,
with `offer-chosen` and `offer-entered` records. `offerAvailable` searches the
innermost dispatch's chain, or a pending transfer's until its action is
entered. An uncaught error ends the Run and queues an
`error` message to the Script's own mailbox, for its `on error` Handler. Core
messages are left out of the Trace, since their wording is outside parity.

Text Patterns run on chapter 8's Pike VM ([matcher](src/machine/matcher.zig)).
A pattern value keeps its canonical source, so the matcher reads it back,
compiles it and runs the program, counting `steps` by the Running rules: the
threads in the list at each position. `make-pattern` splices values into a
template and writes the result's canonical source. A text needle, or a Bytes
needle in Bytes, runs as a literal program. A pattern's logical size compiles
it to count its program. Patterns made at run time can nest without bound, and
a program can be a long chain of splits, so reading, splicing, writing,
compiling and matching keep their pending work on explicit stacks and never
recurse on a pattern or its subject.

A Host defines Capabilities and Grants through `talk.h`
([capabilities](src/machine/capabilities.zig)), and binds Grants at Load, by
the name the Script uses. `ask` and `tell` call immediate and fire-and-forget
Operations: each argument is checked against its Shape first, with nothing
charged for a mismatch, then the declared cost and any `Charge` are charged,
the Host function runs, and its result is checked against the result Shape.
A `Fail` raises its code with its Data as fields, unless it misuses a
catalogue code, a reserved key or an undeclared code, which the Script sees
as `host error`, with a `call-failed` record. The loader checks each literal
argument's kind against its Shape. The corpus runner answers calls from
`stub` lines.

An Operation may open or close a Capability Scope
([the lifecycle contract](../../spec/embedding/scoped-effects.md)). A Run keeps
its occupied slots, by named Grant and scope, in opening order. After the
argument checks, a call that would open an occupied slot, close an empty one
or open one inside a Join is refused, uncharged, and so is a suspending
Operation, `wait`, `wait for`, a waiting send, a Join or another Script's
Function Value while a scope is open. A Host return acknowledges the opening
or closing with a `scope` record before its result is checked. When the Run
ends, the Core calls each slot's abandonment Operation, newest first, with
`automatic` set and nothing charged; a failure disables the Grant, so later
calls raise `capability disabled`.

`talk_script_revoke` queues a `revoke` input. When it is drained, the first
revocation of a name the Script keeps marks that Grant revoked, and later
calls through it raise `capability revoked`, uncharged, after the
`capability disabled` check. A call in flight is left to the Host, and its
answer still resumes the Run. A repeat, or a name the Script doesn't keep, is
recorded and does nothing. A Capability's release hook, from
`talk_with_release_hook` or `store`'s `release`, is called with the reason
`revoke` then, and with `disable` right after the `effect-failure` record of a
failed abandonment. The `stop` and `reload` releases come with Stop and
Reload, in steps 4 and 5.

Segment-bound Operations come from `talk_define_segment_capability`, which
makes each Grant its own Segment Coordinator, or
`talk_define_coordinated_capability`, which maps each Grant's binding to one
when the Grant is made; `talk_define_capability` refuses them. A Run's first
Segment-bound call in a Segment enrolls its Grant and calls the coordinator's
`begin`, after the call's checks and charges. Later calls through Grants
mapped to the same coordinator enroll them with no hook, and any other is
`segment participant conflict`, uncharged. When the Segment ends, after
abandonment, the participant commits, unless the Segment faulted or was
cancelled, or abandonment failed on a participating Grant, when it rolls back.
A failed commit rolls back too, restores the Script Variables to the
Segment's base, which a Script with Segment-bound Grants keeps at each
Segment's start, and ends the Run `effect failed`. An `unknown` outcome or a
failed rollback should stop the Group with `effect state unknown`; until
Stop arrives in step 4, an `unknown` begin raises `host error` after a
rollback attempt, an `unknown` commit ends the Run `effect failed` as a failed
one does, and a failed rollback is reported but stops nothing.

`clock`, `calendar`, `locale` and `console` come from factories with chapter
7's fixed declarations ([standard](src/machine/standard.zig)). `clock.now`
answers from the Pump's Clock. The Core makes the chapter's own checks:
`toInstant`'s date-time and disambiguation and a Locale's option words and
BCP 47 tag before the call, charged nothing, and each result's rules after it,
whose failure is `host error`. A Host function receives the resolved
arguments, with a Locale's options map complete.

`store` (`talk_store_capability`) declares its eight Operations, with `set`,
`delete`, `increment` and `swap` Segment-bound, and maps every binding to the
one Segment Coordinator its implementation gives. The Core refuses an empty
key with `invalid key`, and a `watch` or `unwatch` with an empty name or a
message that isn't a plain Name with `invalid watch`, before the call is
charged. The implementation hears `get`'s and `increment`'s omitted
arguments as Nothing, `keys`' as empty text, and `watch`'s effective message.
A Host failure must name a declared code with the catalogue's fields:
`store full`'s and `watch limit`'s `limit` must be one of the chapter's
words, and the codes the Core raises itself are `host error` from the Host.
Notifications, and so the router, aren't implemented yet.

`sqlite` (`talk_sqlite_capability`) is optional
([values at the boundary](src/machine/sqlite.zig)). Each Grant's binding is a
`talk_sqlite_binding`, and maps to its database's coordinator, which the
implementation gives; `change`, `begin`, `commit` and `rollback` are
Segment-bound, and `begin` opens the scope `transaction` that `rollback`
abandons. Before the call, uncharged, the Core checks `max` (`out of range`),
then that `params` is a list or a map, then each value (`wrong kind` at
argument 2, with its `path`). `query` and `change` then charge `max` times the
per-row cost, `max` defaulting to the binding's cap, convert `params` to SQL
values, and convert the rows back, raising `sql` for a column named twice and
`unrepresentable` for a double it can't hold or text that isn't UTF-8. A
malformed result is `host error`. `talk_store_coordinator`, for a Store kept
in a database, comes later.

`timer` (`talk_timer_capability`) forwards `schedule`'s name, Instant, message
and arguments and `cancel`'s name to the Host, both fire-and-forget. The Host
stores timers and delivers a due one as an ordinary Delivery; the Core keeps
no timer of its own. `user` (`talk_user_capability`) is optional and has no
binding. The Core refuses an empty `choose` with `out of domain` before the
call, and the implementation hears each omitted option resolved: an empty
`prompt`, `default` or `title`, and `multiple` false. `confirm`, `choose` and
`enter` suspend for up to 2,147,483,647 ms, and the Core checks the answer:
a boolean, text or Nothing, and for `choose` Nothing, one of the items, or
with `multiple: true` a subsequence of them. Any other answer ends the call as
`host error`. A suspending call whose Operation checks its answer keeps its
arguments until it is answered or the Group is released.

Runs suspend at `ask … and wait` and `wait d`. A suspended Run lives on the
heap, its Script goes on to its next work, and each Script's work is one
queue of messages and ready Runs, in the order each became ready. A
suspending call's `talk_call` outlives the call, and `talk_call_answer`,
`talk_call_answer_with_cost` and `talk_call_fail` queue Host Inputs that the
next Pump drains; an answer for a call that no longer waits becomes a
`late-answer` note. Each Pump then fires due deadlines, `maxPending` or the
default `MaxWait` for a call, in deadline order, and a timed-out call raises
`timeout` and is abandoned. A resumed Run is charged its answer's terms over
the result and any cost the answer brought. Persistent State counts each
suspended or ready Run's frames, its pending call and what it will resume
with.

Scripts send to each other: `send`, `send … and wait` and the computed-name
and spread forms put the message at the back of the receiver's work, with a
`send` record, and a waiting sender resumes with the reply or `send failed`.
A Script named as a receiver is its name, and `me` with no owner is the
Script itself. A Join starts its members where they stand and suspends once at
its `end`: it resumes with every answer in start order, or with the first
failure, `index` added, and an error leaving the Join abandons its pending
members. A Timeout Block's deadline sits on the frame's stack, bounds every
Suspension Point inside it, and raises `timeout` with `deadline: true`, at once
when it has already passed.

A `wait for` holds the values its branches popped and suspends. Before a
Script dispatches a message, every pending `wait for` in it runs its test
bodies on the waiting Run, which pays for them, in the order the waits began.
A match binds the names its test gives and leaves the message in `it`, and
the message still goes to the Handler Clauses. A timeout or an `after` branch
resumes the Run with Nothing, and a Timeout Block bounds them all.

Host Objects ([objects](src/machine/objects.zig)) are the Group's handles,
each of an Object Kind defined once on the Core with `talk_define_object_kind`,
and their object value's identity is the handle. The Core holds each object's
parent, set by a queued `talk_set_parent` that is checked at the call and
again when drained, each refusal a `refused` record, and `talk_dispose` marks
one disposed. A Script may own an object, which is `me`, and binds well-known
objects by name, which the checker uses for `can't write`. `the k of o` reads
the Kind's Get, with a `prop` record, charged `get-key`, the property's
`getCost` and the value's conversion; `id` is the Core's, and a Guard reads
nothing else. `set` checks the Shape, uncharged when it fails, then runs the
Set. A Delivery or `send` to an object goes to its nearest Owning Script,
whose path is walked again when the message reaches the head of its mailbox,
so a message follows its object if it moves. A Run that ends `unhandled` or
reaches `pass` sends the message on from the parent of the object whose
Owning Script took it, and a Command Call with no Handler climbs from the
parent of `me`. A message with no Owning Script left is reported `unhandled`.

Libraries are compiled once per Core with `talk_compile_library`, against the
Libraries they import and the Grant declarations their Capability calls are
checked and lowered against. Their Constants are evaluated at compile time,
since an initialiser may use only literals, Constants and Built-ins. A code
identity covers each imported Library's identity, in the order the `use` lines
first name them. `talk_add_library` writes the `add-library` record and refuses
a stdlib name, a name the Group holds, or an import the Group doesn't hold.
The seven stdlib Libraries, generated from `spec/stdlib/` into
`src/generated/stdlib_sources.zig`, are compiled the first time a unit imports
one, and every Group holds them. A Library's code runs in the caller's Run:
each frame names the Library whose code it runs, so its constants, Unwind
Table and positions are that unit's. `call-import` calls a Library function
with its defaults, and a Command Call finds an imported Handler. An error raised
in stdlib code looks like a Built-in's: its `at` names the call into the stdlib
and the Core adds its `message`. Loading a Script checks the `needs` of every
Library it imports against its Grants, at the `use` line, and `grantsAsUsed`
keeps the Operations those `needs` call.

A Lambda makes a Function Value with its captures, by name in slot order, and
a function's bare name makes one with none. Each Group keeps one record of
the code a Function Value runs, its Home Script, unit and body, which the
value's identity names. It displays as `<function home:where {captures}>`,
where `where` puts a Library's name before a function's name or a Lambda's
position. Its size is 32 and its captures, since `items` is 0 for it.
`call-value` runs one whose Home Script is this one, and that can't suspend,
in the caller's Run with its captures and defaults, after the `wrong kind`,
`would suspend` and `wrong arity` checks. `call-value-wait` may run one that
suspends, and sends another Script's to its Home Script, whose Run has one
frame and no Handler Clause and writes `fn=` in place of a Handler.
`functionArity` and `functionName` read the code. Stale values wait for
Reload.

The `store` notification router, a Host companion, waits for Save and
Restore.

A Script's limits come from `talk_load_options`' `talk_limits`, a zero field
taking its default from `limits.toml`, and a Delivery's `talk_limit_override`
tightens its Run's Fuel, allocation, MaxWait and MaxJoin; one that loosens is
refused `invalid value`, with the override on its `>` line. A Limit Fault
comes before the faulting instruction's charge, so none of it is made:
- **Its own limit first:** a call past the call depth, a `make-pattern` past
  the Text Pattern size and a Join Member past MaxJoin fault before anything
  else, through `error.LimitFault`.
- **Fuel and allocation:** every other instruction faults when its whole
  charge, dispatch's `clause` rate included, won't fit. A search's `unwind`
  is part of the charge of the instruction driving it, and an error is
  raised, with its record and its Join abandoned, before that charge. A
  Capability call checks its declared cost before the Host is called; one
  whose `Charge` is refused spends its own charge, and one whose result's
  conversion faults on allocation keeps its Fuel before the conversion.
  `store-var` checks its charge before it writes.
- **Persistent State:** a Run-ending `return`, `pass` or `veto` measures the
  Script without the Run before its charge, and a suspension measures it with
  the Run after its charge, abandoning the call it waits on.

The fault's record names the Script Variables its rollback changes back, and
every Script's Segment keeps a base for it. MaxWait bounds a Run's waiting
calls, and a Script's `send` to a mailbox at its depth raises `mailbox full`.
A Host Delivery to a Script whose mailbox and queued Deliveries reach its
depth is refused `TALK_ERR_MAILBOX_FULL`. Fuel Slices and caps, cancellation
and its Cleanup Budget, and Stop come next.

## Values and ownership

`talk.h` implements Nothing, Bool, Text, Int, Uint, FromFloat, Dec, Quantity,
CivilDate, ParseCivilDate, Instant, Bytes, List, Map and Range, and their value
and Decimal accessors. Number text is checked before arithmetic, including
linear rejection of oversized inputs. Arithmetic uses native Zig integers
and arbitrary-precision rational intermediates, with one half-even rounding
and the operator's ideal exponent. Addition, subtraction, multiplication,
division, `div`, `mod` and `^` are available internally, and `^` is also
`power(x, y)`. An integer exponent of any size gives the exact power, rounded
once; any other exponent gives the correctly rounded result with trailing
zeros dropped. Noninteger powers bound e^(y ln x) in fixed point and add
precision until both bounds round alike, after exact results and ties are
found directly. Results that overflow or round to zero are settled from their
magnitude, so huge exponents stay cheap.

Each returned value owns one reference. Constructors copy byte input and
retain child values; text and map keys become NFC. Map keys preserve insertion
order and refuse NFC duplicates. Container writes rebind the root, preserving
aliases and preventing cycles, including insertion of the previous root into
its replacement. Every node remembers its allocator, so Zig tests use the
leak-detecting test allocator. C values use the process allocator; a Group's
own values use its Group allocator. Handles require Host synchronization
when shared across threads.

Text and Decimal accessor pointers borrow their value. Byte accessors copy
out, and display, encoding and canonical Unit strings return an owned
`talk_owned_bytes`, released with `talk_owned_bytes_release`. Child accessors
return owned references; the header documents each lifetime. Encoding refuses
Function Values at any depth and resolves Host Objects through the decoder's
callback. Decoding accepts only the forms the encoder writes: a decoded value
must re-encode to the number, tag and payload the input spelled, so `{"$dec":
"3"}`, `1.0` and a non-UTC or non-shortest `$instant` are refused. JSON white
space and string escapes are syntax, and text is normalised to NFC. Pattern
decoding reparses canonical source; compilation and matching belong to the
front end. Value construction and decoding guard nesting at 128
levels, independently of future Run budgets.

## Corpus runner

`zig build corpus -- [--list] [--check-passing] [case directory ...]` discovers
all case kinds and runs encoding cases through `talk.h`, and Disassembly
Cases through the front end, since `talk.h` exposes no compiled unit, with the
Go runner's messages. It holds each `case.toml` to the language and Cost Model versions
and to the tables and keys that [corpus.toml](../../spec/data/corpus.toml)
allows for its kind. Selectors may name a category or a case, with or without
a `corpus/` prefix. `--list` prints each case's kind and whether it is
supported or deferred, and a failure prints the first divergent line and the
command that reproduces it. [The case setup reader](src/corpus/case.zig)
builds each Script's Grants, with their modes and arities, from the case's
Operation Declarations and Standard Capabilities. Trace Cases replay through
`talk.h` alone ([`talk_replay.zig`](src/corpus/talk_replay.zig)) when they need
only loads, Deliveries and Requests, Pumps, `vars`, `counters`, Host Object
inputs, the Grants it makes and its Libraries, compiled with its Operations as
their Grant declarations. Transcript replay and
encoding cases that register Host Objects are not supported.

`--check-passing` takes no selection. `corpus-passing.txt` lists the cases the
Zig Core must pass in CI: a listed case that fails, disappears or is
unsupported fails the gate. Unlike the Go gate, a case that isn't listed is
reported and skipped when it is unsupported or doesn't pass yet, as the
decisions on #625 say, since the machine grows case by case. A passing case
that isn't listed prints `NEW PASS`, for adding to the list. Expected corpus
bytes are never rewritten. The runner's replay backend says which cases it
supports and replays each from its directory;
[Trace parsing](src/corpus/trace.zig) uses generated record/key metadata,
including filled input keys and optional ids, for the comparison.

## Regenerating tables

[`tools/zig/generate.ts`](../../tools/zig/generate.ts) writes the catalogues
and compiled Cost Model terms from `spec/data/*.toml`, and
[`tools/unicode/generate.ts`](../../tools/unicode/generate.ts) writes
`unicode.zig` and its `UNICODE-LICENSE.txt` from the pinned UCD. Neither reads
another Core.

```sh
bun run zig:generate        # the catalogues
bun run unicode:generate    # the Unicode table, for every Core
```

The catalogues include `grammar.toml`'s word lists, which the parser reads,
and `stdlib.toml`'s Built-ins and stdlib Library exports, which the checker
reads.
`bun run check` holds both to their sources and fails on a stale table. The
emitters write `zig fmt`'s canonical form themselves, so the check needs no Zig
toolchain; CI's `zig fmt --check` holds them to it.
