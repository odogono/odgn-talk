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

## Matching

**Text Pattern**:
A readable alternative to regular expressions for matching text, in the style of SenseTalk's Pattern Language, e.g. `<"ID-", num: 4 digits>`.
_Avoid_: pattern (unqualified), regex

**Destructuring**:
Matching the shape of a structured value (list, map) and binding its parts to names, e.g. `[first, ...rest]` or `{type: "invoice", amount: a}`.
_Avoid_: pattern (unqualified), unpacking

## Values

**Chunk Expression**:
A readable reference to part of a text or list value by ordinal and kind, e.g. `word 3 of line 2 of report`.
_Avoid_: substring, slice

**Unit**:
A unit of measure attached to a number (e.g. `5 kg`), taking part in conversion and arithmetic.
_Avoid_: dimension, suffix
