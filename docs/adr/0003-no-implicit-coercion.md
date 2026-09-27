# No implicit coercion, except to text

Values never change kind by themselves. `"007" + 1` is an error, `"007" = "7.0"` is false (two different texts), `if 0` is an error because conditions must be booleans, and a plain number plus a Quantity is always an error. Conversion is explicit, with `as <kind>`, and `as number` accepts only the language's own literal syntax. The one automatic conversion is **to text**: `&`, `put` and interpolation show any value in its canonical text form, because that direction is total and can't be ambiguous. This deliberately breaks with HyperTalk and SenseTalk, where "everything is a string" and operators coerce whenever they need to. We chose strictness because the Destination calls for strong data types, because Destructuring and Guards need one unambiguous `=`, and because coercion rules that depend on how a value happens to be stored (SenseTalk's `is a` means sometimes "is it" and sometimes "could it convert") are the kind of hidden behaviour beginners trip over.

## Considered Options

- **Loose coercion** (SenseTalk). Convenient, but `=` and `is a` become ambiguous, and strictness is left to global switches such as `strictUnits`.
- **Strict at rest, coercing at arithmetic operators.** Keeps half of the confusion, and makes `+` behave differently from `=`.

## Consequences

- Chunk Expressions return text, so arithmetic on them needs `as number`. Typed captures in Text Patterns and error messages that suggest the fix have to make up for that.
- `=` never errors: values of different kinds, or of different Unit Kinds, are simply unequal. `<` is partial and raises an error outside comparable kinds.
- `is a` tests only the current kind. A separately named test covers "could this convert".
- There are no global switches (`strictUnits`, `numberFormat`) that change how values behave.
