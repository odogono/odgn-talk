# odgn-talk

A HyperTalk-descended scripting language, embeddable in Go servers, Bun servers and browsers, for running untrusted end-user scripts in a sandbox.

## Embedding

**Host**:
The application that embeds the language, runs Scripts, grants Capabilities and sets resource limits. A Go server, a Bun server or a browser page.
_Avoid_: runtime, engine, platform

**Script**:
A unit of source code, written by an end user, that a Host loads and runs.
_Avoid_: program, plugin

**Example Host**:
A small Host kept alongside the spec to exercise the embedding API and the Conformance Corpus end to end. It is not a product.
_Avoid_: demo, sample app, example app

**Capability**:
A Host-granted permission to perform one kind of effect. Scripts have no ambient I/O; every effect goes through a Capability.
_Avoid_: permission, API access

**Operation**:
One named action a Capability offers, e.g. `get` on `http`, called as `ask http to get url` or `tell log to write "done"`. Each Operation is granted, costed and marked suspending or immediate on its own.
_Avoid_: method, command, endpoint

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

## Conformance

**Conformance Corpus**:
The shared set of example Scripts with their inputs and expected Traces that every Core must reproduce exactly. Together with the spec, it is the authority on what the language does.
_Avoid_: test suite, golden tests

**Trace**:
The spec-defined record of what a Script Group observably did: per Segment, its Fuel, allocation, Capability calls with their call ids, sends, outcome and fault step.
_Avoid_: log, transcript, event log

## Tooling

**REPL**:
A command-line Host where a user enters source a line at a time and sees each result straight away, against a live session. Each Core has one.
_Avoid_: console, shell, interpreter

**Playground**:
The browser-page counterpart of the REPL, running the TS Core, where a user writes, runs and shares Scripts.
_Avoid_: sandbox (that word means the security boundary), editor, IDE

## Handlers

**Handler**:
An `on <message> … end <message>` block that runs when its message or event reaches the Script.
_Avoid_: callback, listener, function

**Handler Clause**:
One of several Handlers for the same message, chosen by Destructuring the message's arguments and checking an optional Guard, Elixir-style.
_Avoid_: overload

**Guard**:
The `where` condition on a Handler Clause or match branch. The clause is selected only when the condition holds.
_Avoid_: filter, predicate

**Run**:
One execution of a Handler, from the message that starts it to its end, possibly spanning several Suspension Points. A Script never executes two Runs at the same instant, but a new Run may start while another is suspended.
_Avoid_: activation, invocation, task, thread, process

**Suspension Point**:
A place where a Run may pause and let other Runs of the same Script proceed: a `wait`, or a call to a Suspending Capability. Code between two Suspension Points runs without interruption, and every Suspension Point is known when the Script loads.
_Avoid_: await, yield point

**Suspending Capability**:
A Capability with an Operation that the Host declares may take time to answer, so calling that Operation is a Suspension Point. Every other Operation answers immediately.
_Avoid_: async function, blocking call

**Message Path**:
The chain a message follows when a Script has no matching Handler Clause for it (or a Handler passes it on): from the target object up through the parents the Host declares. What happens at the end of the chain is Host-defined for each kind of message.
_Avoid_: bubbling, propagation, inheritance chain

**Quiescent**:
The state of a Script in which no Run is mid-step: every Run is suspended, queued, or preempted at a time-slice boundary.
_Avoid_: idle, paused, stable

**Script Snapshot**:
The complete state of one or more Quiescent Scripts, taken at one instant: their Script Variables, mailboxes, suspended and preempted Runs, pending Capability calls, resource counters and the last Clock reading, as plain data plus Host Object ids.
_Avoid_: checkpoint, image, dump

**Segment**:
The part of a Run between two consecutive Suspension Points, or between one and the Run's start or end. A Segment is all-or-nothing: if it ends in a Limit Fault, its changes to Script Variables are undone.
_Avoid_: turn, slice, tick

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

**Clock**:
The Host-supplied source of time that the scheduler reads to fire waits and deadlines. The core has no clock of its own.
_Avoid_: timer, system time

## Matching

**Text Pattern**:
A readable alternative to regular expressions for matching text, in the style of SenseTalk's Pattern Language, e.g. `<"ID-", num: 4 digits as number>`. It is also an immutable value kind, so Text Patterns can be stored, passed around and spliced into one another.
_Avoid_: pattern (unqualified), regex

**Capture**:
A named part of a Text Pattern, written `name: element`, whose matched text is bound to that name. A Capture that took no part in the match binds Nothing.
_Avoid_: group, capture group, submatch

**Typed Element**:
A Text Pattern element that both matches a literal of some kind and converts it to that kind, e.g. `a number` or `a date`, so the Capture holding it binds a Number or Civil Date rather than text.
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

**Container**:
Somewhere a value can be put: a variable, or a Chunk Expression or key path rooted in one. Putting into a Container rebinds its root variable.
_Avoid_: slot, lvalue, reference

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

**Unit Kind**:
The family of Units that convert into one another, e.g. mass (`kg`, `lb`) or duration (`s`, `min`).
_Avoid_: dimension, unit type

**Nothing**:
The single value meaning "no value here", distinct from empty text, an empty list or an empty map.
_Avoid_: null, nil, undefined, empty

**Instant**:
A point on the global timeline, independent of any time zone.
_Avoid_: timestamp, date (unqualified)

**Civil Date**:
A calendar date, or date and time of day, with no time zone attached, e.g. `2026-09-27`.
_Avoid_: local date, naive date, date (unqualified)
