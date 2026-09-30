# Errors raised in stdlib code point at the Script's call

An error raised inside a stdlib Library, whether the Library throws it or an operator or Built-in in its code raises it, gets an `at` naming the call that entered the stdlib from the nearest frame that isn't stdlib code. So `pad("x", -1)` points at the Script's own line, not a line of `text.talk`. And an error the stdlib throws with a catalogue code, and no `message`, counts as Core-raised: the Core writes its `message` from the catalogue template, and the Trace leaves it out, as for any Core-raised error. So a stdlib error looks exactly like a Built-in's. We chose this because the stdlib is written in the language only so that its behaviour and Fuel come from one normative source (ADR 0021). Which functions are Built-ins and which are stdlib code is an implementation split, and a Script's author shouldn't have to know it. `offset` and `lastOffset` should fail the same way. A position inside `text.talk` tells the author nothing they can act on, and the stdlib source isn't something they wrote or can see in their editor. Settled while writing the stdlib source (#103).

## Considered Options

- **`at` inside the stdlib, as for any Library:** consistent with user Libraries, but every stdlib error would point at code the author never wrote.
- **The same rule for every Library, user ones included:** a user Library is code the Script's author or their Host wrote and can read, so its own line is useful there, and hiding it would lose that.
- **An `at` for the Script plus a second field for the stdlib position:** more detail, but a new reserved key, for a position only a stdlib maintainer needs. The Trace already records each raise by its instruction.
- **Messages built by the stdlib source,** from the templates: they would be data, so the Trace would keep them, and a change to a template's wording would change every stdlib Trace. The same error from a Built-in and from the stdlib would then be recorded differently.

## Consequences

- **`at`:** narrows ADR 0017 and ADR 0033. The Core adds `at` only when the map has none, as before. For a raise inside stdlib code, it names the call instruction, in the nearest frame down the stack that isn't stdlib code, that entered the stdlib. `unit`, `handler`, `line` and `column` are that frame's.
- **Code the stdlib calls back:** a Function Value that a stdlib function calls, such as a Lambda passed to `map`, is the Script's own code, so an error raised inside it points into it.
- **Messages:** narrows ADR 0017. An error thrown from stdlib code with a catalogue code and no `message` is Core-raised. The Core adds the template `message`, parity doesn't cover its wording, and the Trace leaves it out. The stdlib source never writes a `message`.
- **The Trace** still records each raise by its code and instruction, which inside the stdlib is an instruction of stdlib code ([chapter 11](../../spec/11-the-trace-and-conformance.md)).
- **User Libraries** are unchanged: an error raised in one points into it.
- **Spec:** chapter 6 states the rule, chapter 7 points to it, and the stdlib source drops its hand-built messages.
