# Appendix A: Glossary

> **Note.** This appendix is informative, and generated from [`CONTEXT.md`](../CONTEXT.md), which is its source. Edit `CONTEXT.md`, then run `bun run spec:gen`. The chapters hold the rules, and a term here only says what the chapters mean by it.

<!-- generated: glossary -->

## Embedding

**Host**:
The application that embeds the language, runs Scripts, grants Capabilities and sets resource limits. A Go server, a Bun server or a browser page.
_Avoid_: runtime, engine, platform

**Script**:
A unit of source code, written by an end user, that a Host loads and runs.
_Avoid_: program, plugin

**Library**:
A unit of source code, supplied by the Host, that holds Handlers, functions and Constants for Scripts to use. It has no state, no Grants and no mailbox of its own: its code runs inside the calling Script's Run.
_Avoid_: module, package, include

**Standard Library**:
The seven Libraries every Core ships with the language (`text`, `list`, `map`, `bytes`, `json`, `date`, `units`). Their names are reserved, and no two stdlib names are the same.
_Avoid_: stdlib module, prelude, runtime library

**Built-in**:
A function, property or Constant that is always available without an Import, because it can't be written in the language or a Guard must be able to use it. The Cores implement it natively.
_Avoid_: primitive, intrinsic, native function

**Example Host**:
A small Host kept alongside the spec to exercise the embedding API and the Conformance Corpus end to end. It is not a product.
_Avoid_: demo, sample app, example app

**Capability**:
A Host-granted permission to perform one kind of effect. Scripts have no ambient I/O; every effect goes through a Capability.
_Avoid_: permission, API access

**Standard Capability**:
A Capability whose Operation Declarations the spec fixes, so every Host offers the same shapes, while each Host supplies the answers: `clock`, `calendar`, `locale`, `timer` and `console`.
_Avoid_: built-in capability, system capability, core capability

**Store**:
A Host-kept collection of named values that outlives any one Script load, reached through the `store` Standard Capability. A Store is named by its Grant's binding, so Scripts granted the same name share it. It holds data values under text keys, never Function Values or Host Objects, and its changes commit or roll back with the Segment that made them.
_Avoid_: storage, database, cache, persistent state

**Locale**:
A BCP 47 tag naming the conventions of a language and region, e.g. `"de-CH"`, which the Host resolves to the nearest one it supports.
_Avoid_: language, culture

**Collation**:
A Locale's ordering of text, as opposed to the code-point order the language uses everywhere else.
_Avoid_: alphabetical order, sort order (unqualified)

**Operation**:
One named action a Capability offers, e.g. `get` on `http`, called as `ask http to get url and wait` or `tell log to write "done"`. Each Operation is granted, costed and marked suspending or immediate on its own.
_Avoid_: method, command, endpoint

**Capability Scope**:
A resource lifetime owned by one Run through a named Grant, opened and closed by declared Operations and abandoned by the Core if still open when its Run ends. It does not by itself make effects reversible.
_Avoid_: transaction (for all scopes), lexical scope, using block

**Segment-bound Operation**:
An Operation whose Host effects belong to the calling Segment and remain provisional until that Segment commits or rolls back.
_Avoid_: scoped Operation (for atomic effects), transactional Run

**Operation Declaration**:
The data form of an Operation: its name, argument and result shapes, per-call cost, mode (immediate, suspending or fire-and-forget), longest time pending, and optional Capability Scope and Segment-bound behavior. The same form serves Hosts, the Conformance Corpus and tooling.
_Avoid_: signature, schema, spec (unqualified)

**Value Encoding**:
The spec-defined, lossless JSON form of a value, with `$` tags for kinds that plain JSON can't hold (`{"$quantity": ["2.50", "GBP"]}`). The language-neutral message layer and Host storage use it. Scripts can't reach it, and the Conformance Corpus uses the display form instead.
_Avoid_: wire format, serialisation, tagged JSON

**Message Layer**:
The language-neutral form of the embedding interface: one JSON message per embedding call, with values in the Value Encoding, for a Host that isn't Go or TS, over WASI or a sidecar. The Host starts every exchange, and the Core never calls the Host.
_Avoid_: protocol, wire format, RPC

**Grant**:
A Capability made available to one Script at load, limited to a set of its Operations and carrying the Host's own binding data. The loader checks every Capability call against the Script's Grants.
_Avoid_: permission, token, entitlement

**Host Object**:
An opaque handle to something the Host owns, with identity: copying the handle never copies the thing. The only kind of value through which a Script can observe sharing.
_Avoid_: reference, native object, proxy

**Script Variable**:
A variable declared at Script level, visible to all of the Script's Handlers and kept for as long as the Host keeps the Script loaded.
_Avoid_: global, static, script property

**Core**:
An implementation of the language that Hosts embed: the Go Core or the TS Core. Neither is the reference; both answer to the spec and the Conformance Corpus.
_Avoid_: runtime, engine, interpreter (for the whole), VM

**Script Group**:
A set of Scripts driven by one deterministic scheduler, so the order of messages between them is fixed by the spec. A message from outside the group is an input the Host delivers.
_Avoid_: realm, isolate, shard, cluster

**Group Fingerprint**:
A hash, defined by the spec, of everything that must match for two Script Groups to run in lockstep: the language and Cost Model versions, the code identity of each Script and Library, the Grants' Operation Declarations and the limits. It never covers state.
_Avoid_: checksum, version hash, handshake

**Pump**:
One Host call that runs a Script Group until nothing in it is runnable or its Fuel Slices are spent, leaving it Quiescent. A Group makes progress only inside a Pump.
_Avoid_: tick, step, run (a Run is something else)

**Delivery**:
One message the Host hands to a Script Group from outside, identified by a delivery id that the Run it starts reports.
_Avoid_: event (unqualified), request, dispatch

**Notification**:
A message about a change or occurrence in a Host-owned source, made available to interested Scripts through their Grants under the source-specific notification contract of [ADR 0061](../docs/adr/0061-host-notifications-share-routing-and-are-scoped-by-grant-bindings.md), staged in [Store Notifications](proposals/store-notifications.md). A Store change is one such Notification.
_Avoid_: event (unqualified), broadcast (for a source-specific notification)

**Subscription**:
A Script's ongoing interest in Notifications from a Host-owned source named by its Grant binding. Sharing a message name alone does not give a Script access to that source's Notifications.
_Avoid_: listener, callback, channel (for the interest itself)

**Reconciliation Marker**:
A Notification that calls for refreshing a Subscription's whole watched subset from the source's current state when individual change details are unavailable, such as after notification overload or an offline restore.
_Avoid_: overflow event, dropped notification

**Decision**:
A Delivery by which the Host asks Scripts whether something may happen, such as a game move or a form submit, answered by a Verdict. Only a Handler Clause marked `, deciding` can `veto` it.
_Avoid_: decision-mode event, before-event, hook, query

**Verdict**:
The answer to a Decision: allowed, vetoed (with a reason from each veto) or undecided, when the deciding Run failed or was stopped before it answered. It is sealed at the end of the deciding Run's first Segment, so it never waits on a Suspension Point.
_Avoid_: result, response, outcome (a Run has an outcome)

## Conformance

**Spec**:
The chapters that state every rule of the language once, in its final form, together with their Data Files. Normative by default. It says what the language does, and the ADRs say why.
_Avoid_: standard, reference, docs, ADRs (as a source of rules)

**Data File**:
A machine-readable table in the Spec that both Cores must agree on, such as the error codes, the Unit Catalogue or the Cost Model. It is the truth, and the chapters only show it.
_Avoid_: spec table, config

**Conformance Corpus**:
The shared set of cases (Trace Cases, Disassembly Cases and Session Transcripts) that every Core must reproduce exactly. Together with the spec, it is the authority on what the language does.
_Avoid_: test suite, golden tests

**Trace**:
The spec-defined record of a Script Group's life: the Host Inputs it received, in order, and what it observably did in response (per Segment, its Fuel, allocation, Capability calls with their call ids, sends, outcome and fault step). Because it holds its own inputs, a Trace replays on its own.
_Avoid_: log, transcript, event log

**Host Input**:
One thing the Host does to a Script Group that the Trace records as input: a load, a Pump with its Clock reading, a Delivery, an answer, a cancellation, a save and so on.
_Avoid_: step, event, command

**Trace Case**:
A Conformance Corpus case made of a setup and one Trace. Replaying the Trace's Host Inputs on any Core must reproduce every other line of it exactly.
_Avoid_: test, fixture, golden file

**Disassembly Case**:
A Conformance Corpus case that pairs a Script with the exact Abstract Machine instructions it must compile to.
_Avoid_: bytecode test, snapshot test

**Stub**:
A result a Trace Case supplies in advance for the next call to an immediate Operation (or a charge for a fire-and-forget one), since such a call answers before any later Host Input could.
_Avoid_: mock (unqualified), fake, canned response

**Bless**:
To fill in a case's expected output from the Cores themselves, allowed only when every available Core produces the same output, and followed by human review.
_Avoid_: snapshot, record, accept

**Session Transcript**:
A recorded REPL or Playground session: its Entries and Session Commands in order, with the Clock readings, Capability answers and cancellations it saw. It is a Conformance Corpus case kind, kept in a readable form a user can share, and replaying it must give the same echoed output and Trace on every Core.
_Avoid_: history, log, recording, notebook

## Tooling

**Tooling**:
The programs that help authors write and debug Scripts (the LSP, the formatter, the Lint engine, the debugger and the Playground), built on the TS Core. Nothing they produce is normative.
_Avoid_: SDK, devtools

**REPL**:
A command-line Host where a user enters source a line at a time and sees each result straight away, against a live session. Each Core has one.
_Avoid_: console, shell, interpreter

**Playground**:
The browser-page counterpart of the REPL, running the TS Core, where a user writes, runs and shares Scripts.
_Avoid_: sandbox (that word means the security boundary), editor, IDE

**Launch Entry**:
The Entry a Playground author chooses to evaluate after loading a fresh session, or explicitly against the already loaded session.
_Avoid_: main function, startup script

**Syntax View**:
The Playground's navigable view of how the current source is structured, including incomplete or invalid regions.
_Avoid_: execution tree, runtime state

**Restart**:
In the Playground, replacing the session with a fresh one built from its setup Session Commands and the current tabs. It is not a Reload: no Script Variables carry over, and it starts a new Session Transcript.
_Avoid_: reset, reload, refresh

**Shared Link**:
A Playground URL carrying the Session Script's and user Libraries' sources and, optionally, a Session Transcript, which replays when the link opens.
_Avoid_: permalink, snapshot, save link

**Session Script**:
The one ordinary Script a REPL or Playground session builds up, to which every definition the user enters is added.
_Avoid_: session (as a language concept), workspace, scratch script

**Session Host**:
The part of a REPL or Playground that runs a session as an ordinary Host: it turns each Entry and Session Command into Host Inputs on the Session Script, and prints what comes back. Its behaviour is normative, since Session Transcripts replay through it.
_Avoid_: session (as a language concept), shell, kernel

**Entry**:
One unit of input at a REPL or Playground prompt: one declaration, one statement or one expression. A statement or expression executes as a Run of an implicit Handler of the Session Script.
_Avoid_: line, cell, command, input

**Session Source**:
The Session Script's declarations, in the order they were entered, with each redefinition in its place. It is what an export of the session writes, and what every Reload of the Session Script loads, so a session means exactly what its export means as a file.
_Avoid_: history, buffer

**Foreground Run**:
The Run of the latest Entry, while the Session Host keeps the prompt for it: its console output is printed plainly, the user's typed lines answer its `read`, and an interrupt cancels it. Every other Run is in the background, and its output is printed with its run id.
_Avoid_: current run, active run

**Session Command**:
A `:`-prefixed instruction to the REPL or Playground itself, such as `:limits` or `:clock`, that is not part of the language and cannot be issued by a Script.
_Avoid_: meta-command, directive, magic command

**Host Manifest**:
A data file a Host exports for one kind of Script, describing what that Script can use: its Grants and their Operation Declarations, the Libraries it may import, the messages it may receive and the Host Objects it may meet. Tooling reads it. The Core never does.
_Avoid_: type definitions, SDK, d.ts, host profile

**Lint**:
A piece of advice from tooling about a Script that loads. It never rejects code, and unlike a load-time diagnostic, parity doesn't cover it.
_Avoid_: warning (unqualified), diagnostic (unqualified)

**Test Script**:
A Script an author writes to test their own Scripts. It runs beside them in a fresh Script Group for each test, and reaches them only by message. Tooling runs it, and nothing it produces is normative.
_Avoid_: test suite, spec file, fixture

**Test Handler**:
A Handler of a Test Script that takes no parameters and is named `test` and then a capital, such as `testIncrements`. Each one is one test, which passes only when every Run it causes completes and every message it causes is handled.
_Avoid_: test case (the Corpus has cases), test method

**Harness**:
The Capability only a Test Script is granted, through which it answers the calls the Scripts under test make, reads the calls they made, and moves the Clock on.
_Avoid_: mock framework, fixture, test double

**Test Library**:
The Library a Test Script imports its assertions from. It is supplied by the tooling that runs the test, and is not part of the Standard Library.
_Avoid_: assert library, test framework

**Benchmark**:
One named, measured workload, written once as a Script and run on each Core, and where it has a counterpart, in a Peer Language. It measures speed, not behaviour, and nothing it produces is normative.
_Avoid_: perf test, operation (that word means a Capability's action)

**Benchmark Suite**:
The whole set of Benchmarks, run together to find a Core's slow paths and to compare it with its Peer Languages.
_Avoid_: perf suite, test suite

**Peer Language**:
Another language a Benchmark is compared with: an embeddable scripting language such as Lua or Starlark, a relatable general-purpose one such as Python, or the Core's own host language as a ceiling.
_Avoid_: competitor, rival, baseline (unqualified)

**Lint Profile**:
A named set of Lint levels, `beginner` or `standard`. The Host picks the default and a user may override it.
_Avoid_: layer, level, mode

## Browser authoring

Terms for the planned [browser creative tool](https://github.com/odogono/odgn-talk/issues/154).

**Project**:
An authored collection of Pages, assets and Scripts that forms one interactive creation.
_Avoid_: Stack, Book, application (for the authored creation)

**Page**:
A scrolling visual surface within a Project, containing freely positioned Elements and optionally its own Owning Script.
_Avoid_: Card, screen, canvas (for the Page)

**Element**:
A visual item on a Page: rich text, an image, a button or a shape, optionally with its own Owning Script.
_Avoid_: widget, component, control (for all Element kinds)

**Script Recipe**:
A small editable NorthTalk source example for a common authoring task.
_Avoid_: visual action, macro, behavior block

**Play Session**:
One interaction with a Project from its authored starting state until the reader or author stops playing.
_Avoid_: Run, Session Script, preview (for the session)

**Play State**:
The temporary state of a Play Session, including reader input, visual changes, created or deleted Elements and Script Variables.
_Avoid_: Project, Script Snapshot, saved progress

## Syntax

**Reserved Word**:
One of the small, fixed set of structure words (`on`, `end`, `if`, `put`, `into`, …) that can never be a name. Every other word the language uses has its meaning only where the grammar gives it one, and can be a name elsewhere.
_Avoid_: keyword (unqualified), reserved keyword

**Command Call**:
A statement that starts with a word that isn't a Reserved Word, calling the Handler of that name with the rest of the line as arguments, e.g. `greet "Ann"`. With Argument Labels, the call names the Handler's Selector, e.g. `move knight to "e4"` calls `move:to:`.
_Avoid_: procedure call, invocation, message send (a `send` is something else)

**Import**:
A `use … from …` line naming the definitions a Script or Library takes from a Library, e.g. `use pad, trim from text`. Only the names it lists are brought in.
_Avoid_: include, require

**Lambda**:
A `given` expression that makes a Function Value, e.g. `given r: the wind of r > 10`, or a `given r … end` block whose ending may also be written `end given`.
_Avoid_: anonymous function, block, arrow function, closure

**Match**:
The plain map one Text Pattern match gives: `{text, range, captures, ranges}`, where `captures` and `ranges` are keyed by Capture name. The Match Search gives a list of them.
_Avoid_: match object, match data, result (unqualified)

**Match Search**:
An `every match of <p> in s` expression, giving the list of every match of a Text Pattern in a text.
_Avoid_: find all, global match, comprehension

**Collecting Clause**:
The `collecting e into v` that may end a `repeat` head, gathering one value from each finished pass into a new list in `v`, its target.
_Avoid_: accumulator, collect clause, comprehension

**Beginner Surface**:
Every construct of the language that isn't an Advanced Construct. A beginner never needs anything outside it to do something ordinary.
_Avoid_: beginner mode, subset, level

**Advanced Construct**:
A construct tagged advanced because a Beginner Surface form does the same ordinary job and a beginner reading it couldn't guess what it means, e.g. the pin in `{order: ^orderId}`. It loads and runs like any other.
_Avoid_: advanced mode, extension, expert feature

## Handlers

**Handler**:
An `on <message> … end` block that runs when its message or event reaches the Script. Its ending may repeat the message name as `end <message>`.
_Avoid_: callback, listener, function

**Argument Label**:
A word in a Handler's head, and at its call sites, that names the parameter after it, e.g. `to` in `on move piece to square` and `move knight to "e4"`.
_Avoid_: keyword (that means a Reserved Word or a contextual keyword), named argument, parameter name

**Selector**:
A message's name together with its Argument Labels, written `move:to:`. Two Handlers with different Selectors handle different messages, and a message with no labels keeps its plain name.
_Avoid_: signature, method name

**Handler Clause**:
One of several Handlers for the same message, chosen by Destructuring the message's arguments and checking an optional Guard, Elixir-style.
_Avoid_: overload

**Queueing Policy**:
What a Handler Clause does with a message that arrives while an earlier Run of the clause is still suspended. With no suffix the new Run starts and they run concurrently. `, queued` runs them one at a time, `, dropping` ends the new Run as dropped, and `, replacing` cancels the earlier Run.
_Avoid_: concurrency mode, lock

**Guard**:
The `where` condition on a Handler Clause or match branch. The clause is selected only when the condition holds. A Guard may call Built-ins, but never a Script or Library function or a Function Value.
_Avoid_: filter, predicate

**Run**:
One execution of a Handler, from the message that starts it to its end, possibly spanning several Suspension Points. A Script never executes two Runs at the same instant, but a new Run may start while another is suspended.
_Avoid_: activation, invocation, task, thread, process

**Suspension Point**:
A place where a Run may pause and let other Runs of the same Script proceed: a `wait`, a call to a Suspending Capability, a call to a Handler that may reach one, a Function Value called with `and wait`, or the end of a Join. Each is marked by `wait` in the source, with a Join marked by its `wait for all` head. Code between two Suspension Points runs without interruption, and every Suspension Point is known when the Script loads.
_Avoid_: await, yield point

**Join**:
A `wait for all … end` block whose ending may also be written `end wait`. It starts every Join Member it reaches without waiting, then suspends once, at its closing `end`, until all of them answer. `it` then holds their answers as a list, in the order they were started. The first failure to arrive is raised, and the members still pending are abandoned.
_Avoid_: parallel block, gather, fan-out, Promise.all

**Join Member**:
An `ask … and wait` or `send … and wait` inside a Join. It is started where it stands and answered at the Join's closing `end`.
_Avoid_: branch, task, future

**Suspending Capability**:
A Capability with an Operation that the Host declares may take time to answer, so calling that Operation is a Suspension Point. Every other Operation answers immediately.
_Avoid_: async function, blocking call

**Message Path**:
The chain a message follows when a Script has no matching Handler Clause for it (or a Handler passes it on): from the target object up through the parents the Host declares. What happens at the end of the chain is Host-defined for each kind of message.
_Avoid_: bubbling, propagation, inheritance chain

**Owning Script**:
The one Script whose `me` is a given Host Object, and so the first to receive messages delivered to that object. An object has at most one.
_Avoid_: attached script, behaviour, object script

**Target**:
The object a message was delivered to, written `the target`. It stays the same as the message climbs the Message Path.
_Avoid_: receiver, sender, source

**Broadcast**:
A Delivery to every Script in a Group that currently wants the message, through a Handler for it or a pending `wait for`. It never climbs a Message Path.
_Avoid_: publish, fan-out, multicast

**Quiescent**:
The state of a Script in which no Run is mid-step: every Run is suspended, queued, or preempted at a time-slice boundary.
_Avoid_: idle, paused, stable

**Script Snapshot**:
The complete state of one or more Quiescent Scripts, taken at one instant: their Script Variables, mailboxes, suspended and preempted Runs, pending Capability calls, resource counters and the last Clock reading, as plain data plus Host Object ids.
_Avoid_: checkpoint, image, dump

**Restore**:
Rebuilding a Script Group from a Script Snapshot, on the same Core family. Its Host Objects come back as new handles, keeping their Object Kind, id, parent and disposal.
_Avoid_: load, deserialize, rehydrate

**Resolve**:
The Host's step in a Restore that turns each saved Host Object's Object Kind and id back into the thing the Host owns. One it can't resolve comes back disposed.
_Avoid_: rebind, name resolution (that's for names in Scripts)

**Segment**:
The part of a Run between two consecutive Suspension Points, or between one and the Run's start or end. A Segment is all-or-nothing: if it ends in a Limit Fault, its changes to Script Variables are undone.
_Avoid_: turn, slice, tick

**Stretch**:
One uninterrupted piece of a Segment, from the Run's start, a resume or its continuation after a preemption, to the Segment's end or the next preemption. A Segment that is never preempted is a single Stretch; one preempted by a Fuel Slice spans several.
_Avoid_: slice, burst, run (a Run is the whole handling of one message)

## Resources

**Fuel**:
The deterministic, abstract measure of work a Run does, charged by the Cost Model. The same Script with the same inputs uses the same Fuel on every Host.
_Avoid_: gas, steps, CPU time

**Cost Model**:
The versioned, normative table of how much Fuel each operation costs and how large each kind of value counts as.
_Avoid_: pricing, cost estimate

**Abstract Machine**:
The normative stack machine that every Core's compiler targets: its instruction set, and the exact instructions each construct lowers to. Fuel is charged per instruction, code positions are instruction indices, and a Run can be preempted only between instructions. It is versioned together with the Cost Model.
_Avoid_: bytecode, VM, IR

**Unwind Table**:
The normative table, one per code unit, that says where an error goes: for each instruction range, a `catch`, `finally`, `guard` or `offer` entry and its target. Catch search tests before unwinding, and an offer entry names the active recovery actions. Entering a `try` costs nothing.
_Avoid_: exception table, handler table (a Handler is something else), landing pads

**Fuel Slice**:
A Host-set amount of Fuel after which a Run is preempted at the next instruction boundary, e.g. once per game tick. Fuel spent past the end of a slice is carried as debt into the next one.
_Avoid_: quantum, time slice (unqualified), tick budget

**Allocation Budget**:
The limit on how much value a single Run may construct, counted by logical size, with frees ignored.
_Avoid_: heap limit, memory limit (unqualified)

**Persistent State**:
Everything a Script retains between Segments: its Script Variables, the frames of its suspended Runs and the messages in its mailbox, counted by logical size and capped.
_Avoid_: heap, live memory

**Limit Fault**:
The end of a Run caused by exceeding a resource limit. A Script can never catch it; the failing Segment is rolled back and no further Script code runs in that Run.
_Avoid_: out-of-memory, resource error, exception

**Cleanup Budget**:
The small, Host-set Fuel allowance on which a cancelled Run's `finally` blocks run after its Segment is rolled back. When it runs out, cleanup just ends.
_Avoid_: grace period, finaliser budget

**Clock**:
The Host-supplied source of time that the scheduler reads to fire waits and deadlines, passed as each Pump's one reading. The core has no clock of its own. A Script reads it only through the `clock` Standard Capability.
_Avoid_: timer, system time

## Errors

**Error**:
A plain map with a text `code`, raised by `throw`, by a built-in, by a Capability or by a failed `send … and wait`. It is caught by Destructuring in a `catch` clause; uncaught, it ends the Run as `errored`. Limit Faults and cancellation are not Errors.
_Avoid_: exception, fault (a Limit Fault is something else), failure (unqualified)

**Error Code**:
The lowercase text in words that names what went wrong, e.g. `"capability revoked"`. Codes the Core raises are listed, with their fields, in the error-code catalogue, and parity covers them exactly; the `message` wording is not covered.
_Avoid_: error type, error class, errno

**Recovery Offer**:
A named recovery block declared by active code with `offer`, which a caller may choose before failed frames are discarded. It preserves work in the owning frame and enters declared recovery code after exited cleanup; it never resumes an arbitrary failed expression.
_Avoid_: restart, Error Restart, retry, continuation, resumable exception

**Recovery Catch**:
A catch explicitly marked `before unwind` whose body runs while failed continuations remain retained, so it can choose an active Recovery Offer within the current Run. It cannot suspend, and falling through declines to the next catch. Every catch is tested before unwinding; only an ordinary catch that accepts unwinds.
_Avoid_: error backstop, ordinary catch, handler (unqualified)

**Host Error**:
A Host's misuse of the embedding interface, refused at the Host call that made it with a code from the Host error catalogue, e.g. `clock backwards` or `reentrant call`. It never reaches a Script, unlike an Error or a Capability's `host error`.
_Avoid_: host exception, API error, `host error` (that's a Script-visible Error Code)

## Matching

**Text Pattern**:
A readable alternative to regular expressions for matching text, in the style of SenseTalk's Pattern Language, e.g. `<"ID-", num: 4 digits as number>`. It is also an immutable value kind, so Text Patterns can be stored, passed around and spliced into one another.
_Avoid_: pattern (unqualified), regex

**Capture**:
A named part of a Text Pattern, written `name: element`, whose matched text is bound to that name. A Capture that took no part in the match binds Nothing.
_Avoid_: group, capture group, submatch

**Typed Element**:
A Text Pattern element that both matches a literal of some kind and converts it to that kind, so the Capture holding it binds that kind rather than text. The only one is `a number`.
_Avoid_: typed capture, converter

**Destructuring**:
Matching the shape of a structured value (list, map) and binding its parts to names, e.g. `[first, ...rest]` or `{type: "invoice", amount: a}`.
_Avoid_: pattern (unqualified), unpacking

**Binary Pattern**:
Destructuring for Bytes, written `<< … >>`, that reads fixed-layout fields left to right and binds them, e.g. `<< len: uint16, body: len bytes, ...rest >>`. It never searches and never backtracks. The same brackets build Bytes, with `value as type` fields.
_Avoid_: bitstring, binary match, byte pattern, Text Pattern on bytes

## Values

**Value Semantics**:
The rule that no Script-created value (text, number, list, map) is ever both shared and changeable: changing a value through one name is never visible through another.
_Avoid_: immutability, copy-on-write (those are ways to implement it)

**Kind**:
The category every value belongs to, one of fourteen (`nothing`, `number`, `map`, `function`, `object`, …). It is what `is a` tests and `kindOf` gives. Not a Unit Kind or an Object Kind, which group Units and Host Objects.
_Avoid_: type

**Function Value**:
A value that can be called: made by a Lambda or by naming a Script or Library function, and holding its Home Script, its code and the values it captured.
_Avoid_: closure, callback, function object, lambda (that's the literal)

**Home Script**:
The Script a Function Value was made in, and the only one it ever runs in: a call from anywhere else is a message to it.
_Avoid_: owner, origin, owning script (that's for Host Objects)

**Container**:
Somewhere a value can be put: a variable, or a Chunk Expression or key path rooted in one. Putting into a Container rebinds its root variable.
_Avoid_: slot, lvalue, reference

**Constant**:
A named value fixed when its Script or Library loads, declared with `constant`. It can never be put into. Built-in Constants such as `pi` and `newline` are fixed by the language version instead.
_Avoid_: static, final, script variable (a Script Variable can change)

**Chunk Expression**:
A readable reference to part of a text or list value by ordinal and kind, e.g. `word 3 of line 2 of report`.
_Avoid_: substring, slice

**Character**:
One user-perceived character of text: an extended grapheme cluster under the Unicode version the language version pins. Indexes, ranges, lengths and Text Pattern positions all count Characters.
_Avoid_: code point, rune, char, code unit

**Bytes**:
An immutable sequence of 8-bit values, the kind that Binary Patterns read and build. Its length and positions count bytes, never Characters. Bytes become text only through an explicit `as text`.
_Avoid_: binary, buffer, blob, byte array

**Unit**:
A unit of measure attached to a number (e.g. `5 kg`), taking part in conversion and arithmetic.
_Avoid_: dimension, suffix

**Quantity**:
A number together with its Unit, e.g. `5 kg`. The Unit is part of the value, so `5 kg` and `5` are different values.
_Avoid_: measurement, unit value, tagged number

**Object Kind**:
A family of Host Objects the Host defines once per process, with its properties, such as `door` or `item`. Every Host Object is made with one, and `objectKind` gives its name. Not a Kind: every Host Object's Kind is `object`.
_Avoid_: object type, class

**Unit Kind**:
The family of Units that convert into one another because they measure the same thing, e.g. mass (`kg`, `lb`) or volume (`L`, `m^3`). Exact and calendar durations are separate Kinds, and each currency is a Kind of its own.
_Avoid_: dimension, unit type

**Base Unit**:
The one Unit of each Unit Kind that the others are defined against, and that equality and conversion go through, e.g. `m`, `kg` or `s`.
_Avoid_: SI unit, canonical unit

**Compound Unit**:
A Unit built from other Units by multiplying, dividing and raising to a power, e.g. `mi/hr`, `m^2` or `kg*m/s^2`.
_Avoid_: derived unit, unit expression

**Calendar Unit**:
A Unit of duration (month, year) whose length depends on the date it is added to, so it never converts to exact time and is never part of a Compound Unit.
_Avoid_: nominal duration

**Unit Catalogue**:
The fixed table of every Unit, with its Unit Kind and exact conversion factor, that a language version pins. Neither Hosts nor Scripts can add to it.
_Avoid_: unit registry, unit table, units list

**Range**:
A value made with `..` from two numbers, or two Quantities of one dimension, e.g. `1..10` or `3 m/s..7 m/s`, that `is in` tests and `repeat for each` walks. Chunk indexes and a Match's position are ranges.
_Avoid_: interval, span, slice

**Nothing**:
The single value meaning "no value here", distinct from empty text, an empty list or an empty map.
_Avoid_: null, nil, undefined, empty

**Instant**:
A point on the global timeline, independent of any time zone.
_Avoid_: timestamp, date (unqualified)

**Civil Date**:
A calendar date with an optional time of day, and no time zone attached, e.g. `2026-09-27`. A date-only Civil Date is never equal to one with a time of day, and can't be ordered against it.
_Avoid_: local date, naive date, date (unqualified)

## Text construction

**Raw Text Literal**:
Text enclosed by a matching fence of three or more double quotes, preserving its content without interpolation or escapes, subject to the language's margin and normalization rules.
_Avoid_: Line Text, heredoc

**Interpolated Text**:
Text written between backticks, with expression results inserted when it is evaluated.
_Avoid_: Line Text, template value

**Interpolation Hole**:
An expression inside `${…}` in Interpolated Text, whose text form is inserted at that position.
_Avoid_: placeholder (for an expression)

**Format Template**:
Ordinary text with `${…}` placeholders that a formatting function fills from supplied values or date fields. It contains no captured expressions.
_Avoid_: Interpolated Text, template value

<!-- end -->
