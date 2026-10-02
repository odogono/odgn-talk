# 7. Libraries and the Standard Library

_Draws on:_ [ADR 0002](../docs/adr/0002-single-decimal-number-type.md), [ADR 0003](../docs/adr/0003-no-implicit-coercion.md), [ADR 0005](../docs/adr/0005-durability-is-a-deferred-extension.md), [ADR 0007](../docs/adr/0007-text-patterns-are-linear-time.md), [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md), [ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0029](../docs/adr/0029-text-literals-have-no-escapes-and-line-breaks-are-built-in-constants.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md), [ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md), [ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md), [ADR 0036](../docs/adr/0036-a-ranges-ends-are-read-with-two-built-ins.md), [ADR 0037](../docs/adr/0037-errors-raised-in-stdlib-code-point-at-the-scripts-call.md).

Scripts share code through Libraries: stateless units of source that the Host registers on a Script Group, and whose code runs in the caller's Run. The Standard Library is two tiers. The Built-ins are a small set of functions and Constants that the Cores implement natively and that are always available. The seven stdlib Libraries are written in the language and imported like any other Library. The Standard Capabilities are Capabilities whose Operation Declarations this chapter fixes, and whose answers each Host supplies.

This chapter states what Libraries are and how they are used, then every Built-in, every stdlib export and every Standard Capability Operation. The export lists live in [`stdlib.toml`](data/stdlib.toml). The syntax of `use`, `constant`, `private` and `function` is in [chapter 2](02-grammar.md#source-and-declarations), and the Host calls that register Libraries are in [chapter 9](09-embedding.md).

## Libraries

### What a Library holds

- **A Library** is a unit of source code that the Host registers on a Script Group. It holds Handlers, functions and Constants, and nothing else ([ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md)).
- **It isn't a Script.** It has no Script Variables, no `me`, no mailbox, no Grants and no Owning Script role. It is never loaded, messaged or run on its own. A top-level `script variable` in a Library is a load error.
- **Constants:** `constant name = expr` declares a Constant. Its initialiser may use only literals, other Constants and Built-ins, so evaluating it has no effects. Scripts may declare Constants too. A Function Value in a Library Constant, including nested ones and captures, takes the importing or calling Script as its Home Script when the Constant is bound or read there; its code and display position still name the Library. This also applies to Library parameter defaults. The compiled Library does not bind these values to one Group.
- **Exports:** every top-level definition of a Library is exported unless it starts with `private`. `private` in a Script is a load error.
- **No re-exports:** a name a Library imports isn't exported again, so a `use … from` line always names the Library that defines the name.

> **Example.** A small Library, registered as `layout`:
>
> ```talk
> use padLeft from text
>
> constant ruleWidth = 40
>
> private function widthOf s
>   return the length of s
> end widthOf
>
> function banner title, fill = "*"
>   put ruleWidth - widthOf(title) into room
>   return padLeft(title, widthOf(title) + room div 2, fill)
> end banner
> ```

### Defaults

- **A default:** a function's trailing parameters may have defaults, written `name = expression` ([ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md)). A call may leave off any of those trailing arguments, and each one left off takes its default.
- **What a default may use:** literals, Constants and Built-ins, as a Constant's initialiser may. Anything else, such as another parameter, a Script Variable or a function call, is a load error. A default is fixed at load.
- **Order:** a parameter without a default after one with a default is a load error.
- **Checked at load:** a call that names a function, in the Script or imported, passes at least the parameters without defaults and at most all of them. Any other count is a load error at the call.
- **Checked at run time:** a Function Value made from a named function accepts the same range. A call outside it raises `wrong arity`.
- **Only functions:** Handlers, Lambdas and Capability Operations have no defaults.

This chapter writes every optional argument of a stdlib function or Built-in as a default, as in `round(x, places = 0, mode = "half up")`.

### What Library code may use

- **Allowed:** its own definitions, the Libraries it imports, Built-ins, Capabilities through `ask` and `tell`, and `wait d`.
- **Load errors:** `me`, `the target`, `pass`, `veto`, `wait for`, `send`, a well-known object name ([ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md)), and a Handler that an importer defines.
- **So a Library is a function of its arguments** and of the Capability answers it gets. Anything that depends on its caller is passed in.

### Imports

- **`use a, b from lib`** imports the listed names from the Library `lib`, and they are used unqualified. `use pad from text as padLeft` renames a single import.
- **Only what is listed:** an Import brings in only the names it lists. A Library that later exports more can't break an importer.
- **Where:** `use` is a top-level declaration, in a Script or a Library. Libraries may import Libraries.
- **Missing and cyclic:** importing a name the Library doesn't export, a Library the Group doesn't hold, or a cycle of Libraries is a load error.
- **At a Session prompt,** the stdlib Libraries are always registered, so `use pad from text` works there ([chapter 12](12-sessions-and-tooling.md)).

### Names and clashes

- **Clashes are load errors.** An imported name, after any rename, that clashes with a local Handler, function, Constant, Script Variable or well-known object name is a load error, and so are two Imports of the same name.
- **Built-ins may be shadowed.** An Import, or a Script's or Library's own Handler, function or Constant, may take the name of a Built-in function or Built-in Constant, and the Script's name wins inside it. So a Built-in added in a later language version never stops a Script or Library from loading ([ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md)). How the other names of a body resolve, and which of them may shadow a Built-in, is in [chapter 4](04-expressions-and-statements.md#resolving-a-name).
- **Resolution:** a Command Call resolves to a local Handler, then an imported one, and only then climbs the Message Path ([chapter 5](05-handlers-messages-and-scheduling.md#calling-a-handler-by-name)). Since clashes are errors, the order never breaks a tie.
- **Never entry points:** an imported Handler never runs for a message, and a Library never joins a Message Path.

### Calls into a Library

- **A plain call:** a call into a Library runs in the caller's Run, like a call to the Script's own Handler or function.
- **Charged to the caller:** it charges Fuel, the Allocation Budget and call depth to the caller, and costs the same as a local call in the Cost Model ([chapter 8](08-the-abstract-machine-and-the-cost-model.md)).
- **Frames:** its frames sit on the caller's stack. While the Run is suspended, they count toward the caller's Persistent State.
- **Faults and errors:** a Limit Fault inside Library code rolls back the caller's Segment, as anywhere ([chapter 6](06-errors-and-limits.md#limit-faults)). Errors unwind through Library frames, each through its own Library's Unwind Table, and unwinding is charged per frame.
- **Linked, not inlined:** a call to a Library is resolved at load and lowered as a call to it by name. Its body is never copied into the importer.
- **Suspension:** a Command Call to an imported Handler that may suspend is written `name args and wait`, as for a local one, and a function never suspends ([chapter 5](05-handlers-messages-and-scheduling.md#suspension-points)).
- **Function Values:** a Library function's bare name is a Function Value whose Home Script is the Script that made it, and it runs in that Script's Runs ([chapter 5](05-handlers-messages-and-scheduling.md#function-values-in-another-script)). A Lambda written in a Library can't name a Script Variable, since a Library has none.

### Grants and `needs`

- **A Library has no Grants.** It acts only with its caller's.
- **Declarations for compilation:** `CompileLibrary(src, imports, declarations)` receives a map of names used for Grants to Operation names and their modes and argument Shapes. In TS this is `GrantDecls`, the optional third argument to `compileLibrary`; omission gives an empty map, sufficient only when the Library makes no direct Capability calls. A Library never captures Host functions or binding data. Replacement recompiles dependent Libraries with their saved compilation declarations and rechecks affected Scripts against their own Grants.
- **`needs`:** when a Library is compiled, the loader records every Operation it uses, through the Libraries it imports too, and checks each `ask`, `tell` and `and wait` against the Host's Operation Declarations. The list includes all definitions, including private or unused ones, and `say` counts as `console.write`. It has one entry per distinct `(capability, operation)`, sorted by capability name and then Operation name in Unicode code-point order; `capability` here is the Grant name the Library uses, which the Script may bind to a differently named Capability. The calls are validated on every compilation request, even when their code identity is cached. That list is the Library's `needs`, which the Host can read before any import and which goes into the Host Manifest ([chapter 9](09-embedding.md#the-host-manifest-format)).
- **Checked at import:** loading a Script checks the `needs` of every Library it imports, directly or through another Library, against the Script's Grants. A missing Grant is the Script's load error, reported at the `use` line, and its diagnostic message names the original Library call site, including through transitive imports. At each `use` line, one `missing grant` is reported per distinct missing Operation, naming the first call site encountered in direct source order followed by imported Libraries in import order. All calls are also rechecked against the Script's Operation modes, argument counts and literal Shapes; an incompatible declaration reports the ordinary call diagnostic at the `use` line, naming the original call site. Library compilation and this import check use names as written in Library source; renaming an imported definition never renames a Grant.
- **Grants as used:** a Host that grants "what the Script uses" counts its Libraries' `needs` too.

### Registering, identity and replacing

- **Registration:** the Host compiles a Library once per process and adds it to a Group before loading the Scripts that import it. Adding a Library is a Host Input, recorded in the Trace ([chapter 9](09-embedding.md)). Compiling runs every checker diagnostic, which parity covers. Only the Grant check waits for an import.
- **Imports first:** a Group adds a Library only once it holds every Library that one imports, with the same code identities, and otherwise refuses it (`library mismatch`). A refused add changes nothing.
- **One version per name:** a Group holds at most one Library of each name. A Host may not register a Library under a stdlib Library name (`reserved name`).
- **Code identity:** a Library's code identity covers its source, the language and Cost Model versions, and the identities of the Libraries it imports. A Script's code identity includes the identities of every Library it imports, directly or through another Library. The Group Fingerprint covers them all.
- **Sharing:** a Core compiles each Library once per process, and Groups share it when the code identities match. Code isn't Persistent State. A Library's Constants count once per Group, as a fixed overhead.
- **Code positions:** a code position is a code unit and an instruction index, and a code unit is a Script or a Library named by its code identity ([chapter 8](08-the-abstract-machine-and-the-cost-model.md)). So a suspended Run can be paused inside Library code, and a Snapshot can hold it.
- **Replacing a Library** is one Host Input. The Core recompiles every Library that imports it, then stop-and-reloads every Script that imports any of them, all at once. Script Variables carry over by name if the Host asks. Suspended Runs, including those paused in Library frames, are discarded and reported. If anything fails to check, nothing changes.
- **Stale values:** replacing a Library makes every Function Value made from its code stale, and calling one raises `function gone` ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)).
- **Extending a Script** may add `use` lines, since that adds names without touching existing code ([ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md)).
- **Snapshots** record Library code identities, not source. A restore needs matching Libraries registered first, and a mismatch falls back to a variables-only restore ([chapter 10](10-save-and-restore.md), [ADR 0008](../docs/adr/0008-same-core-save-restore.md)).

## The Standard Library

- **Two tiers:** the Built-ins, which are ambient, and the seven stdlib Libraries, `text`, `list`, `map`, `bytes`, `json`, `date` and `units`, which a Script imports with `use` ([ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md)).
- **Reserved names:** the seven Library names are the only reserved Library names. A new stdlib Library name is a language-version change.
- **Unique names:** every stdlib name, Built-in or exported, is unique across the Built-ins and all seven Libraries, so no combination of stdlib Imports can clash. None is a Reserved Word or a Built-in property. Names are camelCase. The generator checks this against [`stdlib.toml`](data/stdlib.toml).
- **Versioned with the language:** the stdlib is part of the language version, and a stdlib Library's code identity is fixed by it. Its version is the language version, and its identity is computed from its source here as any Library's is ([chapter 9](09-embedding.md#loading-and-libraries)), so it covers the stdlib Libraries it imports.
- **Always there:** every Group holds the seven stdlib Libraries without the Host adding them, and a user Library may import them too.
- **Written in the language:** each stdlib Library's source is normative Spec text, with Disassembly Cases like any Library's. This chapter states what each export does, and the source does exactly that. The source also fixes what this chapter leaves to it: its private helpers, its Fuel, and the order of any calls it makes where this chapter doesn't give one.
- **Operation names** are their own namespace, so an Operation may share a name with a stdlib function, as `locale`'s `upper` does with the `upper` Built-in.

- **The source** is [`spec/stdlib/`](stdlib/), one `.talk` file per Library: [`text`](stdlib/text.talk), [`list`](stdlib/list.talk), [`map`](stdlib/map.talk), [`bytes`](stdlib/bytes.talk), [`json`](stdlib/json.talk), [`date`](stdlib/date.talk) and [`units`](stdlib/units.talk). `bun run grammar:check` parses them, and the generator checks that each exports exactly what [`stdlib.toml`](data/stdlib.toml) lists, with the same parameters and defaults.
- **Errors from stdlib source** look exactly like a Built-in's. A stdlib Library raises a catalogue error with `throw`, giving the catalogue's fields and no `message`. The Core then adds the `message` from the template, and `at` names the Script's call into the stdlib, not a line of the Library ([chapter 6](06-errors-and-limits.md#errors), [ADR 0037](../docs/adr/0037-errors-raised-in-stdlib-code-point-at-the-scripts-call.md)).

### Rules for every stdlib function

These hold for every Built-in function and every stdlib export, unless its own entry says otherwise.

- **Kinds:** an argument of the wrong kind raises `wrong kind`, with `{expected, got, value}`, before any work is done. The tables below don't list it.
- **Out of domain:** an argument of the right kind that the function can't take raises `out of domain`, with `function` its name and `value` the argument. Where two arguments are at fault together, `value` is the list of both.
- **Integers:** a count, width or position must be an integer, and a number that isn't raises `wrong kind` with `expected` `"integer"`, as everywhere ([chapter 3](03-values.md#integers)). An integer outside what the function takes, such as a negative width, raises `out of domain`.
- **Lists:** an argument that must be a list takes a list only. An integer range isn't one, so a Script passes `the items of r`.
- **Positions** are 1-based Character positions, as everywhere in text ([ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md)).
- **White space** is a Character whose first scalar has the Unicode White_Space property, the same test that divides `word`s.
- **Text out** is always NFC.
- **Searching text:** a function that searches text takes a text or a Text Pattern as its needle. A text needle matches only on whole-Character boundaries. A Text Pattern is searched leftmost-first ([ADR 0007](../docs/adr/0007-text-patterns-are-linear-time.md)). No function takes an `ignoring case` flag, so a case-insensitive search passes a Text Pattern, as in `offset(<"abc" ignoring case>, s)`.
- **Showing values:** "shown as `&` shows it" means the canonical text form, the one automatic conversion ([ADR 0003](../docs/adr/0003-no-implicit-coercion.md)).
- **Function Value arguments:**
  - A stdlib function calls a Function Value argument in list order, once per item unless its entry says otherwise, with the number of arguments its entry says.
  - A Function Value that may suspend, or whose Home Script is another Script, raises `would suspend` when it is called ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)). A Script that waits per item writes a `repeat for each` loop, or a Join around sends.
  - A Function Value that can't take that number of arguments raises `wrong arity`.
  - An error raised inside a Function Value unwinds out of the stdlib function unchanged.
  - A test (`keep` or `test`) must give a boolean, and anything else raises `wrong kind` with `expected` `"boolean"`, as `if 0` does.

## Built-ins

- **What qualifies:** a function is a Built-in only if it can't be written in the language, because it needs the pinned Unicode tables, the Text Pattern engine, decimal internals or the representation of a value kind, or if a Guard must be able to call it. Speed alone never makes a function built in ([ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md)).
- **Ambient:** every Built-in is available without an Import.
- **Guards** may call every Built-in, and no other function ([chapter 5](05-handlers-messages-and-scheduling.md#handlers-and-dispatch)). A call through a name that shadows a Built-in isn't a call to the Built-in, so a Guard can't make it ([chapter 4](04-expressions-and-statements.md#guards)).
- **Leaves:** a Built-in never suspends, never calls a Capability and never calls Script code. Each call is one instruction, charged by its Cost Model entry: a static base plus per-unit terms over its operands and result ([chapter 8](08-the-abstract-machine-and-the-cost-model.md)).
- **Unicode:** the pinned Unicode tables are reached only through Built-ins, chunks, Text Pattern classes and `ignoring case`. There is no raw property lookup.

### Properties

The Built-in properties are read with `the <name> of x`. Their names are listed in [chapter 2](02-grammar.md#operands), and what each gives, and of which kinds, is in [chapter 4](04-expressions-and-statements.md#keys-and-properties).

### Values

<!-- generated: stdlib.builtins.values -->

| Built-in | Gives | Also raises |
| --- | --- | --- |
| `min(xs)` | The least item of the list `xs` under `<`, the first of equal ones | `out of domain`, `can't compare` |
| `max(xs)` | The greatest item of the list `xs` under `<`, the first of equal ones | `out of domain`, `can't compare` |
| `codePoint(c)` | The code point of `c`, a text of exactly one code point, as a number | `out of domain` |
| `fromCodePoint(n)` | The text of the code point `n`, normalised to NFC | `out of domain` |
| `upper(s)` | `s` under Unicode full default uppercase mapping, then NFC |  |
| `lower(s)` | `s` under Unicode full default lowercase mapping, then NFC |  |
| `offset(needle, s)` | The Character position where the leftmost match of `needle`, a text or a Text Pattern, starts in `s`, or 0 if there is none |  |
| `isDisposed(o)` | Whether the Host Object `o` has been disposed |  |
| `objectKind(o)` | The name of the Object Kind of the Host Object `o`, as text |  |
| `rangeStart(r)` | The first end of the range `r`, as written |  |
| `rangeEnd(r)` | The second end of the range `r`, as written |  |
| `kindOf(x)` | The name of the kind of `x`, as text, such as `"number"` or `"civil date"` |  |
| `functionArity(f)` | The range of argument counts the Function Value `f` accepts, from its required parameters to all of them |  |
| `functionName(f)` | The name of the function the Function Value `f` was made from, as defined, or Nothing for a Lambda |  |

<!-- end -->

- **`min` and `max`** compare with `<`, so they take any items that `<` orders against each other ([chapter 3](03-values.md#ordering)). The result is the item itself, with its own Unit. An empty list raises `out of domain`, and two items that can't be compared raise `can't compare`.
- **`codePoint(c)`** takes a text of exactly one code point. Any other text raises `out of domain`.
- **`fromCodePoint(n)`** takes an integer from 0 to 1114111 that isn't a surrogate (55296 to 57343). Anything else raises `out of domain`. The result is normalised to NFC, so a few code points come back as a different one.
- **`upper` and `lower`** use Unicode full default case mapping, with no Locale, so the length can change (`upper("ß")` is `"SS"`). Locale case mapping is the `locale` Capability's ([below](#standard-capabilities)).
- **`offset(needle, s)`** gives 0 when there is no match, so a Guard can test it without a failure. An empty text needle matches at 1.
- **`rangeStart(r)` and `rangeEnd(r)`** give a range's two ends exactly as written, for any range, so `rangeStart(5..4)` is `5`, and `rangeEnd(3 m/s..7 m/s)` is `7 m/s`. An empty match's range, `p..p-1`, has no items, and `rangeStart` is how to read where it was ([ADR 0036](../docs/adr/0036-a-ranges-ends-are-read-with-two-built-ins.md)).
- **`isDisposed(o)`** takes a Host Object, and anything else raises `wrong kind`. Guards use it to skip a disposed object at dispatch, as in `where not isDisposed(u)`.
- **`objectKind(o)`** gives the name of the Object Kind `o` was made with, as the Host defined it ([chapter 9](09-embedding.md#host-objects)), so a Guard can route on it, as in `where objectKind(o) is "door"`. It takes a Host Object, and anything else raises `wrong kind`. The kind is the Core's, so it never calls the Host, and a disposed object still answers ([ADR 0044](../docs/adr/0044-a-host-objects-object-kind-is-read-with-a-built-in.md)).
- **`kindOf(x)`** gives the kind name of any value, one of the names in [chapter 3's Kinds table](03-values.md#kinds), the same names an error's `got` field holds. It never raises. A whole number gives `"number"`, since `integer` is a test and not a kind, and a Host Object gives `"object"`, whatever its Object Kind ([ADR 0043](../docs/adr/0043-values-are-introspected-through-built-in-functions.md)).
- **`functionArity(f)`** gives the range of argument counts `f` accepts, the range `wrong arity` checks: from a named function's required parameters to all of them ([ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md)), or `n..n` for a Lambda with `n` parameters. So a function with no parameters gives `0..0`, and `2 is in functionArity(f)` tests a call before it is made.
- **`functionName(f)`** gives the name of the named function `f` was made from, as the code unit that defines it writes it, or Nothing for a Lambda, a Library's included. An Import renamed with `use … as` keeps its Library name, so after `use pad from text as padLeft`, `functionName(padLeft)` is `"pad"`.
- **`functionArity` and `functionName`** take a Function Value, and anything else raises `wrong kind`. They read data the value holds, so a stale Function Value still answers both, and only calling it raises `function gone` ([chapter 3](03-values.md#function-values)).

### Numbers

<!-- generated: stdlib.builtins.numbers -->

| Built-in | Gives | Also raises |
| --- | --- | --- |
| `abs(x)` | `x` without its sign |  |
| `floor(x)` | The greatest integer at or below `x` |  |
| `ceiling(x)` | The least integer at or above `x` |  |
| `truncate(x)` | `x` with its fraction dropped, toward zero |  |
| `round(x, places = 0, mode = "half up")` | `x` rounded to `places` digits after the point, by `mode` | `out of domain` |
| `sqrt(x)` | The square root of `x` | `out of domain` |
| `exp(x)` | e to the power `x` | `overflow` |
| `ln(x)` | The natural logarithm of `x` | `out of domain` |
| `log10(x)` | The base-10 logarithm of `x` | `out of domain` |
| `power(x, y)` | `x` to the power `y` | `out of domain`, `overflow` |
| `sin(x)` | The sine of `x` radians |  |
| `cos(x)` | The cosine of `x` radians |  |
| `tan(x)` | The tangent of `x` radians |  |
| `asin(x)` | The arcsine of `x`, in radians from -pi/2 to pi/2 | `out of domain` |
| `acos(x)` | The arccosine of `x`, in radians from 0 to pi | `out of domain` |
| `atan(x)` | The arctangent of `x`, in radians between -pi/2 and pi/2 |  |
| `atan2(y, x)` | The angle of the point (`x`, `y`) from the positive x-axis, in radians above -pi and at most pi | `out of domain` |

<!-- end -->

- **Exact functions:** `abs`, `floor`, `ceiling`, `truncate` and `round` are exact. `floor`, `ceiling` and `truncate` give an integer with no digits after the point (`floor(-2.5)` is `-3`).
- **On Quantities:** `abs`, `floor`, `ceiling`, `truncate` and `round` also take a Quantity, act on its number and keep its Unit (`round(2.567 kg, 2)` is `2.57 kg`). The other number functions take plain numbers only.
- **`round(x, places = 0, mode = "half up")`:**
  - `places` is an integer, 0 or more, and the result has exactly that many digits after the point, so `round(3, 2)` is `3.00`.
  - `mode` is one of `"half up"`, `"half even"`, `"up"`, `"down"`, `"floor"` and `"ceiling"`, and any other text raises `out of domain`. The names are those of the General Decimal Arithmetic: `"half up"` rounds a tie away from zero, `"up"` rounds away from zero and `"down"` toward it.
  - So by default `round(2.5)` is `3` and `round(-2.5)` is `-3`, while `round(2.5, 0, "half even")` is `2`.
- **Correctly rounded:** `sqrt`, `exp`, `ln`, `log10`, `power` and the trigonometric functions give the exact mathematical value rounded half-even to 34 significant digits, or at exponent −6176 if that keeps fewer digits, then with any trailing zeros after the point dropped ([chapter 3](03-values.md#arithmetic)). So both Cores agree by definition, and `sqrt(4)` is `2` and `exp(0)` is `1`. The one exception is `power(x, y)` for an integer `y`, which is `x ^ y`, so `power(2.50, 2)` is `6.2500`.
- **Domains:** `sqrt` of a negative number, `ln` or `log10` of a number at or below 0, `asin` or `acos` outside -1 to 1, `atan2(0, 0)`, and `power` of a negative number to a non-integer raise `out of domain`, with `value` the argument, which is `x` for `power` and `0` for `atan2`. `power(0, y)` for a negative `y` raises `division by zero`, and `power(0, 0)` is `1`.
- **Overflow:** a result of 10^34 or more in magnitude raises `overflow`, with `operator` the function's name, as in `exp(100)` or `round(x, places)` when `x` has too many integer digits to keep `places` digits after the point. A result too small to keep rounds, and never raises.
- **Angles** are in radians.

### Floats

<!-- generated: stdlib.builtins.floats -->

| Built-in | Gives | Also raises |
| --- | --- | --- |
| `fromFloat64(b, order = "big")` | The number an IEEE 754 binary64 float in the 8 Bytes `b` holds, as its shortest round-trip decimal | `out of domain`, `can't convert` |
| `fromFloat32(b, order = "big")` | The number an IEEE 754 binary32 float in the 4 Bytes `b` holds, as its shortest round-trip decimal | `out of domain`, `can't convert` |
| `toFloat64(n, order = "big")` | The 8 Bytes of the binary64 float nearest `n`, ties to even | `out of domain` |
| `toFloat32(n, order = "big")` | The 4 Bytes of the binary32 float nearest `n`, ties to even | `out of domain` |

<!-- end -->

Floats come into and go out of the language only through these four ([ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)).

- **Byte order:** `order` is `"big"` or `"little"`, and any other text raises `out of domain`.
- **Reading:** `fromFloat64` needs exactly 8 Bytes and `fromFloat32` exactly 4, and any other length raises `out of domain`. The result is the shortest decimal that rounds to the same float, at most 17 or 9 significant digits, the nearest to the float of those, and of two equally near the one whose last digit is even, the same rule as the Host's float-to-decimal conversion. So a binary32 reading of 0.1 is `0.1`. Negative zero gives `0`. NaN, ±Infinity and a value of 10^34 or more in magnitude raise `can't convert`, with `to` `"number"`, as the Host's conversion refuses them ([ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md)).
- **Writing:** `toFloat64` and `toFloat32` round to the nearest float, ties to even. Every number is below the largest float32, so neither ever overflows, and a value too small rounds to zero or a subnormal as IEEE 754 says, keeping its sign, so a negative one can give negative zero. The number 0 gives positive zero.

> **Example.**
>
> ```talk
> put fromFloat32(<<0x3D, 0xCC, 0xCC, 0xCD>>) into x   -- 0.1
> put toFloat64(1.5, "little") into b                   -- <<0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF8, 0x3F>>
> ```

### Dates

<!-- generated: stdlib.builtins.dates -->

| Built-in | Gives | Also raises |
| --- | --- | --- |
| `year(d)` | The year of the Civil Date `d`, from 1 to 9999 |  |
| `month(d)` | The month of `d`, from 1 to 12 |  |
| `day(d)` | The day of the month of `d`, from 1 to 31 |  |
| `hour(d)` | The hour of the date-time `d`, from 0 to 23 | `out of domain` |
| `minute(d)` | The minute of the date-time `d`, from 0 to 59 | `out of domain` |
| `second(d)` | The whole seconds of the date-time `d`, from 0 to 59 | `out of domain` |
| `nanosecond(d)` | The fraction of a second of the date-time `d`, in whole nanoseconds from 0 to 999999999 | `out of domain` |
| `weekday(d)` | The ISO 8601 day of the week of `d`, 1 for Monday to 7 for Sunday |  |
| `dayOfYear(d)` | The day of the year of `d`, from 1 to 366 |  |
| `isoWeek(d)` | The ISO 8601 week number of `d`, from 1 to 53 |  |
| `isoWeekYear(d)` | The ISO 8601 week-numbering year of `d` |  |
| `hasTime(d)` | Whether the Civil Date `d` has a time of day |  |
| `toCivil(i, offset)` | The date-time on the wall clock at `offset` from UTC at the Instant `i` | `out of domain`, `out of range` |
| `toInstant(c, offset)` | The Instant at which the wall clock at `offset` from UTC reads the date-time `c` | `out of domain`, `out of range` |

<!-- end -->

- **Civil Dates only:** the field functions take a Civil Date ([ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md)). An Instant raises `wrong kind`, so a Script turns it into a Civil Date first, with `toCivil` or the `calendar` Capability.
- **Time fields:** `hour`, `minute`, `second` and `nanosecond` of a date-only value raise `out of domain`.
- **ISO 8601 weeks:** `weekday` is 1 for Monday to 7 for Sunday, and `isoWeek` and `isoWeekYear` follow ISO 8601 week numbering. Day names come only from the `locale` Capability.
- **Fixed offsets:** `offset` in `toCivil` and `toInstant` is an exact duration Quantity that is a whole number of minutes and less than 24 hr in magnitude. UTC is `0 s`. Any other offset raises `out of domain`.
- **`toInstant(c, offset)`** takes a date-time, and a date-only value raises `out of domain`.
- **Range:** a result outside 0001-01-01 to 9999-12-31 raises `out of range`, with `field` `"year"`.
- **Names:** `day`, `month`, `year` and `min` are also Units, and `second` an ordinal, but a Unit is only a suffix straight after a numeric literal and an ordinal only follows `the`, so `day(d)` and `second(d)` are calls.

> **Rationale.** A time field of a date-only value raises `out of domain` rather than `wrong kind`, because a date-only value and a date-time share the kind name `civil date`, and `wrong kind` would name the same kind twice ([ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md)).

### Constants

<!-- generated: stdlib.builtins.constants -->

| Constant | Value | Is |
| --- | --- | --- |
| `pi` | `3.141592653589793238462643383279503` | pi, rounded half-even to 34 digits |
| `newline` | `U+000A` | A line feed, as text |
| `tab` | `U+0009` | A tab, as text |
| `quote` | `U+0022` | A double quote, as text |

<!-- end -->

A Guard may use the Built-in Constants, and a Script's own name may shadow them ([Names and clashes](#names-and-clashes)).

## `text`

<!-- generated: stdlib.text -->

| Export | Gives | Also raises |
| --- | --- | --- |
| `pad(t, width, fill = " ")` | `t` with `fill` added at the end until it is `width` Characters long | `out of domain` |
| `padLeft(t, width, fill = " ")` | `t` with `fill` added at the start until it is `width` Characters long | `out of domain` |
| `trim(t)` | `t` without the white space at its start and end |  |
| `trimStart(t)` | `t` without the white space at its start |  |
| `trimEnd(t)` | `t` without the white space at its end |  |
| `split(t, separator)` | The list of the texts between the matches of `separator`, a text or a Text Pattern, in `t` | `out of domain` |
| `join(xs, separator = "")` | The items of `xs`, each shown as `&` shows it, with `separator` between each pair |  |
| `repeated(t, n)` | `n` copies of `t`, joined | `out of domain` |
| `lastOffset(needle, t)` | The Character position where the last match of `needle`, a text or a Text Pattern, starts in `t`, or 0 if there is none |  |
| `format(template, values)` | `template` with each `{name}` replaced by the value of that key of `values`, shown as `&` shows it | `out of domain` |
| `formatNumber(n, symbols, places = nothing)` | The number `n` written with a Locale's `numberSymbols`, rounded to `places` digits after the point if `places` is given | `out of domain` |
| `parseNumber(t, symbols)` | The number `t` writes with a Locale's `numberSymbols` | `can't convert`, `out of domain` |

<!-- end -->

- **`pad` and `padLeft`:** `width` is an integer, 0 or more, and `fill` a text of exactly one Character, or they raise `out of domain`. A text already `width` Characters or longer comes back unchanged, so they never truncate.
- **`trim`, `trimStart` and `trimEnd`** remove white space Characters.
- **`split(t, separator)`:**
  - A text separator matches as a needle does, left to right, without overlapping. An empty text separator raises `out of domain`.
  - A Text Pattern separator matches where the Match Search `every match of separator in t` finds its matches, and an empty match separates nothing.
  - The result always has one more item than there are separators, so `split("a,,b,", ",")` is `["a", "", "b", ""]` and `split("", ",")` is `[""]`. This differs from `items`, where a trailing delimiter makes no empty item.
- **`join(xs, separator = "")`** shows each item as `&` shows it, so a list of numbers joins without converting first.
- **`repeated(t, n)`:** `n` is an integer, 0 or more.
- **`lastOffset(needle, t)`** gives the start of the last of the successive matches the Match Search finds, taking a text needle as a Text Pattern that matches exactly that text. So `lastOffset("aa", "aaa")` is `1`.
- **`format(template, values)`** is the language's only interpolation:
  - `{name}` shows the value of the key `name` of the map `values`, as `&` shows it. `{{` and `}}` are literal braces.
  - A name that isn't a key raises `out of domain` with `value` the name. An unclosed `{`, or a `}` that isn't doubled, raises it with `value` the template.
  - There is no width or precision: `pad` and `round` do that.

> **Example.**
>
> ```talk
> use format, pad, split from text
>
> on show
>   put format("{name} owes {amount}", {name: "Ann", amount: 2.50 GBP}) into owed   -- "Ann owes 2.50 GBP"
>   put pad("id", 5, ".") into head   -- "id..."
>   put split("a;b;c", ";") into parts   -- ["a", "b", "c"]
> end show
> ```

### Numbers in a Locale

`formatNumber` and `parseNumber` write and read numbers with the separators and digits a Locale gives, from the `locale` Capability's `numberSymbols` ([ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md)). They are written in the language, so rounding, grouping and parse errors are the same on every Host.

- **`symbols`** is a map with every key `numberSymbols` gives: `decimal`, `group` and `minus` as text, `digits` as a list of ten texts, zero first, and `primaryGroup`, `secondaryGroup` and `minGrouping` as integers. Anything else raises `out of domain`, with `value` the map.
- **`formatNumber(n, symbols, places = nothing)`:**
  - `n` is a plain number, and a Quantity raises `wrong kind`, so a Script formats the number part itself.
  - Without `places`, the digits are those of the canonical form, written out without an exponent, so trailing zeros survive. With `places`, an integer, 0 or more, the number is first rounded as `round(n, places)` rounds it.
  - A negative number starts with `minus`. The fraction, if there is one, follows `decimal`. Each digit is written with `digits`.
  - The integer part is grouped only when it has at least `primaryGroup + minGrouping` digits. Then `group` goes before the last `primaryGroup` digits and before every `secondaryGroup` digits to the left of those, so a `secondaryGroup` of 2 writes `12,34,567`.
- **`parseNumber(t, symbols)`:**
  - It accepts exactly what `formatNumber` could write for some `places`, and the same without any group separators: an optional `minus`, at least one digit, and optionally `decimal` followed by at least one digit. There is no exponent, no plus sign and no white space.
  - The result keeps its digits, so `"2,50"` in a Locale with a `,` decimal gives `2.50`.
  - A mismatch, or a number past the [number limits](03-values.md#reading-numbers), raises `can't convert`, with `{value, to: "number", offset}` and `offset` the position of the first Character that doesn't fit.

> **Example.**
>
> ```talk
> use formatNumber from text
>
> on price amount
>   ask locale to numberSymbols "de-DE"
>   put formatNumber(1234567.5, it, 2) into shown   -- "1.234.567,50"
> end price
> ```

## `list`

<!-- generated: stdlib.list -->

| Export | Gives | Also raises |
| --- | --- | --- |
| `sum(xs)` | The items of `xs` added with `+`, left to right, or 0 for an empty list | `incompatible units` |
| `average(xs)` | The sum of `xs` divided by its length | `out of domain`, `incompatible units` |
| `zip(xs, ys)` | The list of pairs `[x, y]` of items at the same position, as long as the shorter list |  |
| `unique(xs)` | `xs` without the items equal to an earlier item |  |
| `reverse(xs)` | `xs` in reverse order |  |
| `flatten(xs)` | `xs` with each item that is a list replaced by its items, one level deep |  |
| `sort(xs, direction = "ascending")` | `xs` sorted by `<`, stably | `out of domain`, `can't compare` |
| `sortBy(xs, key, direction = "ascending")` | `xs` sorted by `<` on the value `key` gives for each item, stably | `out of domain`, `can't compare` |
| `sortWith(xs, compare, direction = "ascending")` | `xs` sorted by the two-argument comparator `compare`, stably | `out of domain` |
| `filter(xs, keep)` | The items of `xs` for which `keep` gives true, in order |  |
| `map(xs, f)` | The list of what `f` gives for each item of `xs`, in order |  |
| `reduce(xs, f, initial)` | `f(f(f(initial, x1), x2), …)` over the items of `xs`, or `initial` for an empty list |  |
| `group(xs, key)` | A map from each text `key` gives to the list of items that gave it, keyed in first-seen order |  |
| `partition(xs, keep)` | `[matching, rest]`: the items for which `keep` gives true and the others, each in order |  |
| `any(xs, test)` | Whether `test` gives true for some item, stopping at the first that does |  |
| `all(xs, test)` | Whether `test` gives true for every item, stopping at the first that doesn't |  |
| `find(xs, test)` | The first item for which `test` gives true, or Nothing |  |
| `indexOf(xs, value)` | The position of the first item equal to `value`, or 0 if there is none |  |

<!-- end -->

- **`sum` and `average`** add with `+`, left to right from the first item, so a list of Quantities sums in the first item's Unit. A number and a Quantity together raise `wrong kind`, and Quantities of different dimensions raise `incompatible units`. `average` of an empty list raises `out of domain`.
- **`zip`** stops at the end of the shorter list. **`unique`** compares with `=` and keeps each first occurrence. **`flatten`** goes one level deep.
- **`filter`, `map`, `partition`, `any`, `all` and `find`** call their Function Value with one argument, the item. `any`, `all` and `find` stop at the first item that settles the answer. `any` of an empty list is false, and `all` of one is true. `partition` always gives two lists.
- **`reduce(xs, f, initial)`** calls `f` with two arguments, the value so far and the item.
- **`group(xs, key)`** calls `key` with one argument. Its result must be text, since map keys are text, and anything else raises `wrong kind` with `expected` `"text"`. Each list keeps its items in input order.
- **`indexOf(xs, value)`** compares with `=`.

### Sorting

- **`direction`** is `"ascending"` or `"descending"`, and any other text raises `out of domain`, with `value` the direction.
- **Keys:** `sort` sorts by the items themselves. `sortBy` first calls `key` once per item, in order, with the item, and then sorts by the keys it gave. Lists order lexicographically under `<` ([ADR 0003](../docs/adr/0003-no-implicit-coercion.md)), so a list key sorts by several keys, as in `sortBy(rs, given r: [the city of r, the temp of r])`.
- **The merge sort:** all three sort the same way, so the order of comparisons, and so the order of comparator calls and the first `can't compare`, is fixed:
  1. A list of fewer than 2 items is already sorted.
  2. Otherwise, sort its first ⌊n/2⌋ items and its remaining items, each the same way.
  3. Merge the two halves. While both have items left, compare the first remaining item of the first half, `left`, with the first remaining item of the second, `right`. Take `right` if it must come strictly before `left`, and otherwise take `left`. Then append what remains of either half.
- **Strictly before:** for `sort` and `sortBy`, ascending, `right` comes first when `key(right) < key(left)`, and descending when `key(left) < key(right)`. For `sortWith`, `compare(left, right)` is called with two arguments and must give a number, or it raises `wrong kind`. Ascending, `right` comes first when the number is greater than 0, and descending when it is less than 0.
- **Stable:** items that tie keep their input order, in either direction.
- **Mixed directions** chain stable sorts, the last sort being the main key: `sortBy(sortBy(rs, temp, "descending"), city)` sorts by city, then by falling temperature. Or they use `sortWith`.

> **Example.**
>
> ```talk
> use sortBy, filter, map, reduce from list
>
> on summarise readings
>   put filter(readings, given r: the wind of r > 10) into gusty
>   put sortBy(gusty, given r: the temp of r, "descending") into hottest
>   put map(hottest, given r: the city of r) into cities
>   put reduce(readings, given total, r: total + the rain of r, 0 mm) into rain
> end summarise
> ```

## `map`

<!-- generated: stdlib.map -->

| Export | Gives | Also raises |
| --- | --- | --- |
| `merge(a, b)` | The map with the entries of `a` and then of `b`, where `b`'s value wins for a key in both |  |
| `without(m, keys)` | `m` without the entries whose keys are in the list `keys` |  |
| `pick(m, keys)` | `m` with only the entries whose keys are in the list `keys`, in `m`'s order |  |
| `entries(m)` | The list of pairs `[key, value]` of `m`, in order |  |
| `fromEntries(pairs)` | The map with the entries of the list of pairs `pairs`, where a later pair wins for a repeated key |  |
| `mapValues(m, f)` | `m` with each value replaced by what `f` gives for it, keys and order kept |  |

<!-- end -->

- **Order:** maps keep insertion order. `merge(a, b)` gives `a`'s keys in `a`'s order, with `b`'s value for a key in both, then `b`'s other keys in `b`'s order.
- **Key lists:** `keys` in `without` and `pick` is a list of text. A key that isn't in `m` is ignored.
- **`fromEntries(pairs)`:** each pair is a list of exactly two items, the first a text. A list of another length raises `out of domain` with `value` the pair. A repeated key keeps its first position and takes the last value.
- **`mapValues(m, f)`** calls `f` with one argument, the value, in the map's order.

## `bytes`

<!-- generated: stdlib.bytes -->

| Export | Gives | Also raises |
| --- | --- | --- |
| `toHex(b)` | The Bytes `b` as lowercase hexadecimal text, two digits per byte |  |
| `fromHex(t)` | The Bytes the hexadecimal text `t` writes | `can't convert` |
| `toBase64(b)` | The Bytes `b` in the base64 alphabet of RFC 4648, padded |  |
| `fromBase64(t)` | The Bytes the padded base64 text `t` writes | `can't convert` |
| `toBase64Url(b)` | The Bytes `b` in the base64url alphabet of RFC 4648, unpadded |  |
| `fromBase64Url(t)` | The Bytes the unpadded base64url text `t` writes | `can't convert` |
| `decodeText(b, encoding = "utf-8", mode = "strict")` | The text the Bytes `b` hold in `encoding`, normalised to NFC | `can't convert`, `out of domain` |
| `encodeText(t, encoding = "utf-8")` | The Bytes of the text `t` in `encoding` | `can't convert`, `out of domain` |

<!-- end -->

- **Hexadecimal:** `toHex` writes lowercase digits. `fromHex` accepts digits in either case, an even number of them and nothing else: no spaces and no `0x`.
- **Base64:** `toBase64` and `fromBase64` use the alphabet of RFC 4648 section 4, with `=` padding. `toBase64Url` and `fromBase64Url` use the alphabet of section 5, without padding. The readers accept only the canonical form: the right alphabet, the right length and padding, zero in any unused trailing bits, and no white space.
- **Errors:** a text these readers can't accept raises `can't convert`, with `{value, to: "bytes", format, offset}`, where `format` is `"hex"`, `"base64"` or `"base64url"`, and `offset` is the position of the first Character that doesn't fit, or the last Character when the length is wrong.

### Text encodings

`decodeText` and `encodeText` name one of these encodings. Any other text raises `out of domain`, with `value` the name.

<!-- generated: stdlib.encodings -->

| Encoding | Bytes |
| --- | --- |
| `"utf-8"` | UTF-8, as the Unicode Standard defines it; a leading U+FEFF is dropped when decoding |
| `"utf-16le"` | UTF-16, each code unit little-endian, with surrogate pairs; a leading U+FEFF is dropped when decoding |
| `"utf-16be"` | UTF-16, each code unit big-endian, with surrogate pairs; a leading U+FEFF is dropped when decoding |
| `"latin-1"` | ISO/IEC 8859-1: each byte is the code point of the same value, from U+0000 to U+00FF |
| `"windows-1252"` | The windows-1252 index of the WHATWG Encoding Standard: bytes 0x80 to 0x9F map as that index says, and every other byte as in latin-1 |

<!-- end -->

- **`decodeText(b, encoding = "utf-8", mode = "strict")`:**
  - In `"strict"` mode, bytes that aren't well-formed in the encoding raise `can't convert`, with `{value: b, to: "text", format: encoding}`. `latin-1` and `windows-1252` decode every byte.
  - In `"replace"` mode, each maximal ill-formed subsequence becomes U+FFFD, as the Unicode Standard's "U+FFFD substitution of maximal subparts" says. For UTF-16, an unpaired surrogate or an odd final byte each become one U+FFFD.
  - Any other `mode` raises `out of domain`.
  - A leading U+FEFF is dropped for the three UTF encodings, and the text is then normalised to NFC.
- **`encodeText(t, encoding = "utf-8")`** writes the scalars of `t`, which is already NFC, and never writes a byte order mark. A Character with no byte in `latin-1` or `windows-1252` raises `can't convert`, with `{value: t, to: "bytes", format: encoding}`.
- **`as text` and `as bytes`** stay strict UTF-8 ([ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md)). The one difference from `decodeText(b)` is that `b as text` keeps a leading U+FEFF.

> **Rationale.** UTF-8 and UTF-16 cover what current systems write, and `latin-1` and `windows-1252` cover the legacy Western text that spreadsheets and old files still produce. Every one of them maps bytes to code points without tables larger than 32 entries, so they can be written in the language. Other legacy encodings (Shift_JIS, GB 18030, the other ISO 8859 parts) need large tables, and a Host that must read them decodes the bytes itself and passes text in ([ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md)).

## `json`

<!-- generated: stdlib.json -->

| Export | Gives | Also raises |
| --- | --- | --- |
| `decodeJson(t)` | The value the JSON text `t` holds | `can't decode` |
| `encodeJson(v)` | The value `v` as compact JSON text | `not encodable` |

<!-- end -->

### The JSON mapping

This mapping is the one rule for plain JSON. The `json` Library follows it, and so does each Core's Host-side JSON codec ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)). The lossless form for every kind is the Value Encoding, which only Hosts can reach ([chapter 9](09-embedding.md)).

| JSON | Value |
| --- | --- |
| `null` | Nothing, allowed inside lists and maps |
| `true`, `false` | a boolean |
| a number | a number, exactly as written |
| a string | a text, normalised to NFC |
| an array | a list |
| an object | a map, in the order its members are written |

- **Decoding, `decodeJson(t)`:**
  - `t` is one JSON value as RFC 8259 defines it, with optional JSON white space (space, tab, LF, CR) before and after.
  - A number is read exactly, keeping its digits, so `2.50` decodes to `2.50`, and `-0` to `0`. A JSON exponent is applied, and a positive result exponent is rescaled to 0, so `1e5` decodes to `100000` and `2.50e1` to `25.0`. A number past the [number limits](03-values.md#reading-numbers) is invalid. Numbers are never read through a float.
  - A string's escapes are decoded, and a `\u` surrogate pair gives one scalar. A lone surrogate, or an unescaped control character, is invalid.
  - Two members of one object whose names are equal after NFC are invalid.
  - `decodeJson` never produces a Quantity, range, Civil Date, Instant or Bytes.
  - Invalid JSON raises `can't decode`, with `{format: "json", offset}`, where `offset` is the position of the first Character that can't continue valid JSON, or one past the end.
- **Encoding, `encodeJson(v)`:**
  - The output is compact, with no white space between tokens.
  - Nothing is `null`. A number is written in its canonical form, so trailing zeros survive. A list is an array. A map is an object, in the map's order.
  - A text is a JSON string. `"` and `\` are written `\"` and `\\`. U+0008, U+0009, U+000A, U+000C and U+000D are written `\b`, `\t`, `\n`, `\f` and `\r`, and the other characters below U+0020 as `\u00` and two lowercase hex digits. Every other character is written as itself.
  - A Quantity, range, Civil Date, Instant, Bytes, Text Pattern, Host Object or Function Value raises `not encodable`, with `{kind, path}`: `kind` is its kind name, and `path` the list of keys and 1-based indices that leads to it from `v`, for the first such value in depth-first order. There is no object form for them. A Script converts first: `q as text` gives `"5 kg"`, `q / 1 kg` a plain number, and `formatDate` a date.

> **Example.** `encodeJson({name: "Ann", scores: [2.50, nothing]})` gives the text `{"name":"Ann","scores":[2.50,null]}`, and `decodeJson` of that text gives the map back. `encodeJson({total: 5 kg})` raises `not encodable` with `kind` `"quantity"` and `path` `["total"]`.

## `date`

<!-- generated: stdlib.date -->

| Export | Gives | Also raises |
| --- | --- | --- |
| `makeDate(y, m, d)` | The date-only Civil Date `y`-`m`-`d` | `out of range` |
| `makeDateTime(y, m, d, h, mi, s = 0, ns = 0)` | The date-time `y`-`m`-`d` at `h`:`mi`:`s` and `ns` nanoseconds | `out of range` |
| `atTime(d, h, mi, s = 0, ns = 0)` | The date-time on the date of `d` at `h`:`mi`:`s` and `ns` nanoseconds | `out of range` |
| `dateOnly(d)` | The date of the Civil Date `d`, without its time of day |  |
| `daysInMonth(d)` | The number of days in the month of the Civil Date `d` |  |
| `isLeapYear(y)` | Whether the integer `y` is a leap year in the proleptic Gregorian calendar |  |
| `formatDate(d, template)` | The Civil Date `d` written by `template` | `out of domain` |
| `parseDate(t, template)` | The Civil Date the text `t` writes by `template` | `can't convert`, `out of domain`, `out of range` |
| `splitDuration(d)` | The exact duration `d` as the map `{days, hours, minutes, seconds}` | `incompatible units` |
| `monthsBetween(a, b)` | The number of whole calendar months from the Civil Date `a` to `b`, negative if `b` is earlier | `can't compare` |
| `epoch` = `1970-01-01T00:00:00Z` | The Unix epoch, as an Instant |  |

<!-- end -->

- **Building:** `makeDate`, `makeDateTime` and `atTime` are written in the language over `as civil date`. Each field is an integer in its range: year 1 to 9999, month 1 to 12, day 1 to the month's length, hour 0 to 23, minute 0 to 59, second 0 to 59, and nanosecond 0 to 999999999. Anything else raises `out of range`, with `field` the field's name (`"year"`, `"month"`, …) and `value` the argument. Nothing is ever normalised, so `makeDate(2026, 2, 30)` raises.
- **`atTime(d, h, mi, s = 0, ns = 0)`** adds a time of day to a date-only value. A date-time raises `out of domain`, and a Script that wants to replace a time writes `atTime(dateOnly(d), …)`.
- **`isLeapYear(y)`** takes any integer, by the proleptic Gregorian rule.
- **`splitDuration(d)`** takes an exact duration Quantity and gives plain numbers: whole `days`, `hours` from 0 to 23 and `minutes` from 0 to 59, with the fraction kept in `seconds`, which is less than 60. A negative duration gives the parts of its magnitude, each negated. A Quantity of another Unit Kind raises `incompatible units`.
- **`monthsBetween(a, b)`** takes two date-only values or two date-times, and mixing them raises `can't compare`. When `a` is at or before `b`, it is the greatest `n` for which `a + n months` is at or before `b`, with month arithmetic clamping the day as [chapter 3](03-values.md#date-arithmetic) says. When `b` is earlier, it is minus `monthsBetween(b, a)`. So from 2026-01-31 to 2026-02-28 is `1`.
- **`epoch`** is the Instant `1970-01-01T00:00:00Z`. A Unix timestamp `n` is `epoch + n s`, and back again is `(i - epoch) / 1 s`.

### Templates

`formatDate` and `parseDate` share one template language of named, numeric fields in braces ([ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md)).

- **Tokens:** `{year}`, `{month}`, `{day}`, `{hour}`, `{minute}`, `{second}` and `{weekday}`, each with an optional width `:n`, and `{fraction:n}`, the first n digits of the nanoseconds, with n from 1 to 9. `{{` and `}}` are literal braces. Everything else is literal text.
- **All numeric:** there are no names, no 12-hour clock and no AM/PM, which are Locale concerns. Month and day names come from the `locale` Capability.
- **A valid template** holds `{year}`, `{month}` and `{day}`. A time token needs `{hour}` and `{minute}`. Each token appears at most once. Any other token, a missing width on `{fraction}`, an unclosed `{` or a `}` that isn't doubled is invalid. An invalid template raises `out of domain`, with `value` the template.
- **`formatDate(d, template)`:**
  - `d` is a Civil Date, so an Instant goes through `toCivil` or the `calendar` Capability first. A template with time tokens given a date-only value raises `out of domain`, with `value` the date.
  - Digits are ASCII. `:n` pads with zeros to n digits and never truncates. `{fraction:n}` truncates the nanoseconds to n digits.
- **`parseDate(t, template)`:**
  - The whole text must match. Literal text matches exactly. A token with a width takes exactly that many ASCII digits, and one without takes the longest run of one or more.
  - Seconds and nanoseconds default to 0. The result is a date-only value unless the template has time tokens.
  - A mismatch, or a `{weekday}` that disagrees with the date, raises `can't convert`, with `{value: t, to: "civil date", format: template, offset}` and `offset` the position of the first Character that doesn't fit, or of the weekday's digit.
  - A field that matches but is outside its range raises `out of range`, as `makeDate` does.

> **Example.**
>
> ```talk
> use formatDate, parseDate, makeDateTime from date
>
> on stamp
>   put makeDateTime(2026, 9, 27, 14, 5) into d
>   put formatDate(d, "{day:2}/{month:2}/{year} {hour:2}:{minute:2}") into shown   -- "27/09/2026 14:05"
>   put parseDate("2026-09-27", "{year}-{month}-{day}") into back   -- 2026-09-27
> end stamp
> ```

## `units`

<!-- generated: stdlib.units -->

| Export | Gives | Also raises |
| --- | --- | --- |
| `celsiusToFahrenheit(c)` | `c * 9 / 5 + 32` |  |
| `fahrenheitToCelsius(f)` | `(f - 32) * 5 / 9` |  |
| `celsiusToKelvin(c)` | `c + 273.15` |  |
| `kelvinToCelsius(k)` | `k - 273.15` |  |
| `fahrenheitToKelvin(f)` | `(f - 32) * 5 / 9 + 273.15` |  |
| `kelvinToFahrenheit(k)` | `(k - 273.15) * 9 / 5 + 32` |  |

<!-- end -->

- **Plain numbers:** each takes and gives a plain number. Temperature Units are differences only ([ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md)), so an absolute temperature is a plain number, and a Quantity raises `wrong kind`.
- **Order of operations:** each computes exactly the expression in its entry, left to right, rounding each step as arithmetic does ([ADR 0002](../docs/adr/0002-single-decimal-number-type.md)). So `celsiusToFahrenheit(100)` is `212`.

## Standard Capabilities

A Standard Capability is a Capability whose Operation Declarations this chapter fixes, so every Host offers the same shapes, while each Host supplies the answers: `clock`, `calendar`, `locale`, `timer` and `console` ([ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md)).

- **Ordinary Capabilities otherwise:** a Script reaches one only through a Grant, under the name it is granted as, and calls it with `ask` or `tell` ([ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md)). A Script that calls one it wasn't granted fails to load, and there is no silent fallback. A Grant may still limit a Script to some of its Operations.
- **The Host** implements each Operation, with any library it likes, except `clock.now`, and sets each one's per-call cost ([chapter 9](09-embedding.md)).
- **Parity:** the Trace records each answer. A Trace Case supplies Host answers as Stubs; `clock.now` reads the Pump's Clock without a Stub ([chapter 11](11-the-trace-and-conformance.md)).
- **Modes:** every `clock`, `calendar` and `locale` Operation is immediate, both `timer` Operations and `console`'s `write` are fire-and-forget, and `console`'s `read` is suspending.
- **Arguments** are checked against the fixed Shapes before the Host function runs, and a mismatch raises `wrong kind` ([chapter 6](06-errors-and-limits.md#errors-from-capabilities)). Where an Operation takes a word from a fixed list, the Core checks the word too, and any other raises `out of domain`, with `function` the Operation's name.
- **Error codes:** the `calendar` Operations declare `unknown zone` and `ambiguous time`, and the Host fails with them. The Core raises `bad locale` itself. Chapter 6 says how both are checked.

### `clock`

<!-- generated: stdlib.capability.clock -->

| Operation | Mode | Gives | Errors |
| --- | --- | --- | --- |
| `now` | immediate | The Pump's Clock reading, as an Instant |  |

<!-- end -->

`clock` has no zone. A Script that only timestamps events needs no zone, and reading the time is a Grant of its own. Its answer is the Pump's Clock reading, so the Host implements nothing.

`now` takes no arguments and returns an Instant. It declares no Script error codes.

### `calendar`

<!-- generated: stdlib.capability.calendar -->

| Operation | Mode | Gives | Errors |
| --- | --- | --- | --- |
| `today [zone]` | immediate | The date-only Civil Date in the zone at the Pump's Clock reading | `unknown zone` |
| `now [zone]` | immediate | The date-time in the zone at the Pump's Clock reading | `unknown zone` |
| `toCivil i [, zone]` | immediate | The date-time in the zone at the Instant `i` | `unknown zone` |
| `toInstant c [, disambiguation] [, zone]` | immediate | The Instant at which the zone's wall clock reads the date-time `c` | `unknown zone`, `ambiguous time` |
| `offset i [, zone]` | immediate | The zone's offset from UTC at the Instant `i`, as an exact duration | `unknown zone` |
| `zone [zone]` | immediate | The IANA id of the zone in use | `unknown zone` |

<!-- end -->

- **Shapes:** `today`, `now` and `zone` take one Optional text; `toCivil` and `offset` take an Instant and one Optional text; `toInstant` takes a Civil Date and two Optional texts. An omitted or Nothing zone uses the Grant's default. The factory passes that as an absent zone to the Host, which reads its binding. The supplied argument list, including Nothing, remains unchanged in the Trace.
- **Zones:** the Grant binds a default IANA zone id, and every Operation takes an optional trailing zone id that overrides it. An unknown zone makes the Host fail with `unknown zone`, with `{zone}`.
- **`toInstant c [, disambiguation] [, zone]`:** `c` is a date-time; a date-only value raises `out of domain`, with `function: "toInstant"` and `value: c`. With two supplied arguments, a second argument that is one of `"compatible"`, `"earlier"`, `"later"` and `"reject"` is the disambiguation, and any other text is a zone. With three supplied arguments, the second is the disambiguation and the third the zone; an unrecognised disambiguation raises `out of domain`, with `function: "toInstant"` and `value` the second argument. Omitted or Nothing disambiguation means `"compatible"`. These domain checks follow Shape checks, before charging the call or running the Host function.
- **Gaps and overlaps:** `"compatible"`, the default, moves a time in a DST gap forward by the gap's length, and takes the earlier Instant for a time in an overlap. `"earlier"` and `"later"` take that Instant in both cases. `"reject"` makes the Host fail with `ambiguous time`, with `{civil, zone}`.
- **Results:** `today` gives a date-only value, and `now` and `toCivil` a date-time. `toInstant` gives an Instant. `offset` gives an exact duration in `s`, and `zone` text naming the IANA id in use. The Core checks these result kinds, the presence or absence of a Civil Date's time, and the exact `s` Unit; a mismatch becomes `host error`. The Host supplies zone data and applies the gap/overlap rules.

> **Example.**
>
> ```talk
> on remind due
>   ask calendar to today
>   if due - it < 7 days then tell log to write "due soon"
> end remind
> ```

### `locale`

<!-- generated: stdlib.capability.locale -->

| Operation | Mode | Gives | Errors |
| --- | --- | --- | --- |
| `compare a, b [, options] [, tag]` | immediate | -1, 0 or 1, as the text `a` sorts before, with or after `b` under the Locale's Collation | `bad locale` |
| `rank texts [, options] [, tag]` | immediate | A map from each distinct text of the list `texts` to its dense, 1-based rank under the Locale's Collation | `bad locale` |
| `upper s [, tag]` | immediate | `s` under the Locale's uppercase mapping, then NFC | `bad locale` |
| `lower s [, tag]` | immediate | `s` under the Locale's lowercase mapping, then NFC | `bad locale` |
| `numberSymbols [tag]` | immediate | The map `{decimal, group, minus, digits, primaryGroup, secondaryGroup, minGrouping}` for the Locale | `bad locale` |
| `monthNames [options] [, tag]` | immediate | The Locale's 12 month names, January first | `bad locale` |
| `dayNames [options] [, tag]` | immediate | The Locale's 7 day names, Monday first | `bad locale` |
| `tag [tag]` | immediate | The BCP 47 tag of the Locale in use, after fallback | `bad locale` |

<!-- end -->

- **Call shape:** the arguments come first, then an optional options map, then an optional BCP 47 tag. The two optional arguments are told apart by kind, a map against a text, as in `ask locale to compare a, b, {sensitivity: "base"}, "de"`. `compare` requires two texts, `rank` a list of texts, and `upper` and `lower` one text; the other Operations have no required arguments. `compare`, `rank`, `monthNames` and `dayNames` accept an Optional choice of their closed options map or text, followed by Optional text. The others accept just Optional text. If both optional positions are supplied, the first must be a map or Nothing; text there raises `out of domain`, with `function` the Operation name and `value` that text.
- **Defaults:** omitted or Nothing options mean an empty map, and omitted or Nothing tags use the Grant binding. The factory fills absent option keys with the defaults below, passing a complete map to the Host in the documented key order. An absent tag reaches the Host as absent; it reads the default from its binding. The Core validates the effective tag on each call; an explicit tag overrides even a malformed default. The Trace keeps only the supplied arguments, including explicit Nothing.
- **Checks:** option maps allow only the listed keys, with text for word-valued fields and boolean for `numeric`; a present Nothing field breaks its Shape. After Shape checks, the Core checks option words in map order, then the effective tag, before charging the call or entering the Host. Unknown words raise `out of domain`, with `function` the Operation name and `value` the word. `bad locale` is raised only by the Core; the Host error declarations are empty, so every Host failure becomes `host error`.
- **Naming a Locale:** the Grant binds a default tag, and any call can name another. A tag that isn't well-formed BCP 47 raises `bad locale`, with `{locale}`, before the Host runs. Well-formed means the case-insensitive ASCII ABNF of [RFC 5646 §2.1](https://www.rfc-editor.org/rfc/rfc5646.html#section-2.1), including private-use and grandfathered tags. As [§2.2.9](https://www.rfc-editor.org/rfc/rfc5646.html#section-2.2.9) distinguishes, this is syntax, not registry validity: the Core does not check registrations, duplicate variants or duplicate extension singletons. It neither trims nor canonicalises tags, and does not consult platform Locale data. A well-formed tag the Host doesn't support falls back by lookup, dropping subtags from the right (`de-CH` to `de`), down to the root Locale `und`, which every Host supports. `tag` gives the tag in use, after fallback.
- **Every Operation for every Locale:** a Host that offers `locale` implements every Operation for every tag it resolves to.
- **Collation options,** for `compare` and `rank`: `sensitivity`, one of `"base"`, `"accent"`, `"case"` and `"variant"` (the default), and `numeric`, a boolean, false by default, which sorts `"file 10"` after `"file 9"`.
- **`rank texts`:** every item of `texts` must be text. The answer maps each distinct text to its rank, dense and 1-based, with texts that compare equal sharing one. The Core checks the answer: its keys must be exactly the distinct texts it was given, and its ranks dense, or the call ends as `host error`.
- **Sorting by Collation** uses `rank` and a stable sort, so texts of equal rank keep their input order. `rank` takes the place of a comparator, which would put one `locale` call per comparison in the Trace.
- **Case:** `upper` and `lower` use the Locale's case mapping, such as Turkish dotted İ. The `upper` and `lower` Built-ins keep full default case mapping, and `ignoring case` keeps simple folding.
- **`numberSymbols`** gives the closed map `{decimal, group, minus, digits, primaryGroup, secondaryGroup, minGrouping}`, as [Numbers in a Locale](#numbers-in-a-locale) uses it: nonempty texts for the three separators/signs, ten nonempty texts for `digits`, and positive integers for the three grouping fields.
- **Results:** the Core checks `compare` is exactly -1, 0 or 1; `upper` and `lower` return text (Value construction ensures NFC); `monthNames` and `dayNames` return lists of exactly 12 and 7 texts; `numberSymbols` meets the rules above; and `tag` returns well-formed tag text. A mismatch becomes `host error`. The Host supplies the actual mappings, Collation and Locale data, including supported-tag lookup and fallback.
- **Name options,** for `monthNames` and `dayNames`: `width`, one of `"long"` (the default), `"short"` and `"narrow"`, and `form`, one of `"format"` (the default), for use inside a date, and `"standalone"`. `item weekday(d) of it` names a date's day.

> **Example.**
>
> ```talk
> use map, sortBy from list
>
> on showPeople people
>   ask locale to rank map(people, given p: the name of p)
>   put it into ranks
>   put sortBy(people, given p: the (the name of p) of ranks) into sorted
> end showPeople
> ```

### `timer`

<!-- generated: stdlib.capability.timer -->

| Operation | Mode | Gives | Errors |
| --- | --- | --- | --- |
| `schedule name, at, message, args` | fire-and-forget | Stores a durable timer that delivers `message` with the list `args` to the Script at the Instant `at`, replacing one of the same name |  |
| `cancel name` | fire-and-forget | Removes the Script's timer called `name`, if there is one |  |

<!-- end -->

`timer` is the durable-timer pattern for waits that must outlive memory ([ADR 0005](../docs/adr/0005-durability-is-a-deferred-extension.md)). `wait` stays in memory only.

- **`schedule name, at, message, args`:** `name` is a text, `at` an Instant, `message` a message name as text, and `args` a list. Names are scoped to the Script, and scheduling a name again replaces its timer.
- **`cancel name`** removes the timer, and cancelling an unknown name does nothing.
- **Delivery:** the Host stores timers durably. When one is due, the Host delivers `message` with `args` to the Script as an ordinary Delivery, at its next opportunity if `at` has already passed. The Core takes no part in it.

`schedule` takes exactly four arguments, with Shapes text, Instant, text and a list of `any`; `cancel` takes exactly one text. As with every Host boundary, the list cannot contain Function Values, even nested in Containers. Neither Operation declares Script error codes, so a Host failure becomes `host error`.

### `console`

<!-- generated: stdlib.capability.console -->

| Operation | Mode | Gives | Errors |
| --- | --- | --- | --- |
| `write value` | fire-and-forget | Shows the text form of `value`, any value, as one or more lines of output |  |
| `read` | suspending | The next line of input the user types, as text, without its line break |  |

<!-- end -->

`console` is the user's terminal or output pane. Every REPL and Playground session grants it, and any other Host may ([chapter 12](12-sessions-and-tooling.md#the-console)).

- **`write value`** takes any value, and the Host shows its [text form](03-values.md#the-text-form). `say x` is short for `tell console to write x`.
- **`read`** answers with the next line the user types, as text, without its line break. Its `maxPending` is 2,147,483,647 ms, the largest `MaxWait` every Core honours, so a user can take their time ([chapter 6](06-errors-and-limits.md#limits)).

`write` takes exactly one argument, with the `value` Shape: every value, including Function Values nested in lists or maps. `read` takes no arguments and returns text, including empty text for an empty line. Both declare no Script error codes; a Host failure becomes `host error`. The Console factory forwards `write`'s Value to the Host, which shows its text form, and starts `read` with a `Call` that the Host answers with text. Both calls retain the Grant's binding and the Script's name.

## Outside parity

- **Standard Capability answers:** each Host's zone rules, Locale data and supported Locales are its own. The Trace records every answer, so a replay follows the Host it came from.
- **Per-call costs** of Standard Capability Operations are set by each Host.
