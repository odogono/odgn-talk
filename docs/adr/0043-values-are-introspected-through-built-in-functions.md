# Values are introspected through Built-in functions

`kindOf(x)` gives the kind name of any value as text, `functionArity(f)` the range of argument counts a Function Value accepts, and `functionName(f)` the name of the function it was made from, or Nothing for a Lambda. So `kindOf(3)` is `"number"`, `functionArity(tax)` is `1..2` for `function tax amount, rate = 20`, and `functionName(given x: x)` is Nothing. They are Built-ins, so a Guard may call them. We chose this because a Script could test a kind with `is a` but never get one, and could read a Function Value's arity or name only by parsing its display form, which is fragile and never meant for Scripts. Every stdlib Library carried the same private 14-way `is a` chain, named `kindOf`, just to fill an error's `got` field. All three read data the value already holds, so they can't affect parity, and they qualify as Built-ins under ADR 0021 both because they read a value's representation and because Guards need them. Settled in #176.

- **`kindOf`** gives exactly the names in chapter 3's Kinds table, which are already what `is a` tests and what an error's `expected` and `got` fields hold. It never raises. A whole number is `"number"`, since `integer` is a test after `is a` and not a kind. A Host Object is `"object"`, whatever its Object Kind.
- **`functionArity`** gives the range `wrong arity` checks: from a named function's required parameters to all of them (ADR 0035), and `n..n` for a Lambda. A range, rather than a pair, reads with `is in`, and `rangeStart` and `rangeEnd` read its ends (ADR 0036).
- **`functionName`** gives the name as the code unit that defines the function writes it. An Import renamed with `use … as` keeps its Library name, since the Function Value holds the Library's function and not the Import line, as its display form does (`<function weather:text:pad>`). The Library isn't part of the name.
- **Stale Function Values** still answer both, since a stale value stays an ordinary value. Only calling one raises `function gone`.

## Considered Options

- **Built-in properties, such as `the kind of x` or `the name of f`:** they read better, but a Built-in property always wins over a map key (ADR 0019), so `the kind of order` would stop reading a map's `kind` key in every Script that has one.
- **`functionArity` as a pair `[min, max]`:** it doesn't read with `is in`, and its wording would differ from `wrong arity`'s.
- **A Library-qualified name, such as `"text:pad"`:** text with a separator in it invites parsing, which is the fragility these Built-ins remove. The Library can get its own Built-in if a Script ever needs it.
- **The local name of a renamed Import:** it exists only in the importing Script's source, and two Scripts importing the same function under different names would get different answers for equal values.
- **`"integer"` for whole numbers:** `integer` isn't a kind, and `kindOf` would then disagree with `got`.
- **The Object Kind for a Host Object:** it would make `kindOf` give names outside the Kinds table. Reading an Object Kind is a separate question.
- **The names `kindOf` and `arity`:** `functionArity` and `functionName` follow `rangeStart` and `rangeEnd` (ADR 0036) in naming the kind they read.

## Consequences

- **Built-ins:** narrows ADR 0021. `kindOf`, `functionArity` and `functionName` join the value Built-ins, each a fixed Fuel charge plus the size of its result. `functionArity` and `functionName` take a Function Value, and anything else raises `wrong kind`.
- **Names:** all three are new stdlib names, unique across the Built-ins and the seven Libraries, and a Script's own names may shadow them (ADR 0034). A Script that already defines one keeps its own. Adding Built-in names before 1.0 can clash like this, and shadowing is what keeps such Scripts loading.
- **The stdlib:** all seven Libraries drop their private `kindOf` helper and call the Built-in, so their code identities change. The blessed stdlib Trace Cases are reblessed for that. No blessed case raised a stdlib `wrong kind`, so no Fuel figure changed.
- **Unchanged:** the display form of a Function Value, `is a`, and the `wrong arity` check, which reads the same range `functionArity` gives.
- **Conformance:** the TS Core implements them, and the Corpus cases in `corpus/builtins/` pin them. The Go Core doesn't exist yet (ADR 0040), and inherits those cases.
