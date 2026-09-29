# Value semantics for all Script-created data

Text, numbers, lists and maps have Value Semantics: no Script-created value is ever both shared and changeable. A write to a Container (`put "x" into char 3 of y`, `add 1 to item 2 of totals`) rebinds its root variable, so it is never visible through another name, a Handler argument, a suspended Handler, a closure or a running loop. Host Objects are the only values with identity, and Scripts cannot create their own. We chose this because HyperTalk-style containers already behave this way for beginners, because Elixir-style Handler Clauses and Guards need values that cannot change under them, and because a hard multi-tenant sandbox is simpler to account for when state is plain data. The spec states only the observable rule. Whether the runtime uses copy-on-write or persistent structures is left to the runtime architecture.

## Considered Options

- **Reference semantics** (JS/Python). Familiar to experienced programmers, but it's a classic beginner trap. It would also let values change while a Handler is suspended or while a Guard is being checked.
- **Mixed** (text and numbers are values, lists and maps are references). Has the same problems for any structured data, plus a rule that differs by type and that beginners have to learn.

## Consequences

- Equality is structural for Script values and by identity for Host Objects.
- Memory is charged on logical size, as if nothing were shared, so Go and TS cores charge the same.
- Values crossing the Host boundary are snapshotted going out and converted coming in. Only Host Objects cross as handles.
- Closures (if the language has them) capture values, not variables. Loops iterate over a snapshot of their subject.
- Script Variables are the only changeable state shared between Handlers of a Script.
- Narrowed by ADR 0025: the language has closures, as Function Values. They capture locals by value, read-only, and read and write Script Variables live. A Function Value is plain data (Home Script, literal, captured values), and equality is structural, so it adds no identity to Script values.
- Narrowed by ADR 0030: "converted coming in" means a Host builds every value through a named constructor on one opaque, tagged `Value` type per Core, whose rule the spec states. Input the value model can't hold is refused at the Host API, and nothing is clamped, rounded or replaced.
