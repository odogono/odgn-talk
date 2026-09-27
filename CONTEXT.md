# odgn-talk

A HyperTalk-descended scripting language, embeddable in Go servers, Bun servers and browsers, for running untrusted end-user scripts in a sandbox.

## Embedding

**Host**:
The application that embeds the language, runs Scripts, grants Capabilities and sets resource limits. A Go server, a Bun server or a browser page.
_Avoid_: runtime, engine, platform

**Script**:
A unit of source code, written by an end user, that a Host loads and runs.
_Avoid_: program, plugin

**Capability**:
A Host-granted permission to perform one kind of effect. Scripts have no ambient I/O; every effect goes through a Capability.
_Avoid_: permission, API access

**Host Object**:
An opaque handle to something the Host owns, with identity: copying the handle never copies the thing. The only kind of value through which a Script can observe sharing.
_Avoid_: reference, native object, proxy

**Script Variable**:
A variable declared at Script level, visible to all of the Script's Handlers and kept for as long as the Host keeps the Script loaded.
_Avoid_: global, static, script property

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
A Capability that the Host declares may take time to answer, so calling it is a Suspension Point. Every other Capability answers immediately.
_Avoid_: async function, blocking call

**Message Path**:
The chain a message follows when a Script has no matching Handler Clause for it (or a Handler passes it on): from the target object up through the parents the Host declares. What happens at the end of the chain is Host-defined for each kind of message.
_Avoid_: bubbling, propagation, inheritance chain

## Matching

**Text Pattern**:
A readable alternative to regular expressions for matching text, in the style of SenseTalk's Pattern Language, e.g. `<"ID-", num: 4 digits>`.
_Avoid_: pattern (unqualified), regex

**Destructuring**:
Matching the shape of a structured value (list, map) and binding its parts to names, e.g. `[first, ...rest]` or `{type: "invoice", amount: a}`.
_Avoid_: pattern (unqualified), unpacking

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
