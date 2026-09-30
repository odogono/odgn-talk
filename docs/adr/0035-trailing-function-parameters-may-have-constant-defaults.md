# Trailing function parameters may have constant defaults

A `function` may give its trailing parameters defaults: `function sortBy xs, key, direction = "ascending"`. A call may then leave off any of those trailing arguments, and each one left off takes its default. A default follows the rule for a Constant's initialiser (ADR 0020). It may use only literals, Constants and Built-ins, so it has no effects and is fixed at load. A parameter without a default after one with a default is a load error. A call that names the function is checked at load, and it must pass at least the required arguments and at most all of them. A call through a Function Value is checked when it runs, and gets `wrong arity` otherwise. Handlers and Lambdas get no defaults. We chose this because the settled stdlib already has optional trailing arguments: `sortBy(xs, key)` and `sortBy(xs, key, "descending")` (#66), `formatNumber(n, symbols)` and `formatNumber(n, symbols, places)` (ADR 0024), and `makeDateTime` with optional seconds and nanoseconds (ADR 0023). But the grammar gave a function a fixed list of names, and the stdlib Libraries are written in the language (ADR 0021), so they had no way to express these. A default in the head shows the optional arguments where a reader, the loader and completion all look for them. A constant default keeps a call free of hidden effects, and it keeps the head readable without running any code. Settled while writing chapter 7 (#91).

## Considered Options

- **Missing trailing arguments bind Nothing,** and the body checks for them: no grammar change, but every Script function loses its load-time arity check, and `f(a)` for a two-argument `f` would run instead of failing where it's written.
- **Separate fixed-arity names** (`sortBy` and `sortByDescending`, `formatNumber` and `formatNumberTo`): it reverses #66, which chose one name with a trailing text in the style of `round`'s mode, and it doubles the names in a namespace that must stay unique (ADR 0021).
- **Overloading by arity** (two `function sortBy` definitions with different parameter counts): two definitions under one name, which ADR 0020's clash rule forbids everywhere else, and a bare name as a Function Value would be ambiguous.
- **An options map as the last argument** (`sortBy(xs, key, {descending: true})`): ADR 0025's prototype found that it reads worse, and #66 moved away from it.
- **Defaults that are any expression, evaluated at each call:** a default could then read a Script Variable or call a function, so leaving off an argument could have effects the call doesn't show.
- **Defaults on Handler parameters:** a Handler's parameters are Destructuring patterns, and its Handler Clauses already dispatch on the number of arguments, so a default would compete with clause selection.
- **Defaults on Lambda parameters:** `given r = 1: …` would read as a comparison, and a Lambda passed to `map` or `filter` is always called with a fixed number of arguments.
- **Named arguments at the call** (`sortBy(xs, key, direction: "descending")`): a new call form that the two-token grammar would have to decide after `(`, for a need that trailing positions already meet.

## Consequences

- **Syntax:** narrows ADR 0019.
  - `Function ::= 'function' Name ( Parameter ( ',' Parameter )* )? NL Block 'end' Name NL`, with `Parameter ::= Name ( '=' Expression )?`.
  - `=` here means "defaults to", as it means "starts as" in a Script Variable or Constant. The default runs to the next top-level comma or the end of the line.
  - It needs no new word and no new two-token decision: after a parameter name, the next token is `=`, `,` or the end of the line.
- **Load rules:** narrows ADR 0020.
  - A default may use only literals, Constants and Built-ins, as a Constant's initialiser may. Anything else, a parameter name included, is a load error.
  - A parameter without a default after one with a default is a load error.
  - A call that names the function, whether in the Script or imported from a Library, passes between the required count and the full count of arguments. Any other count is a load error at the call.
- **Run time:** narrows ADR 0025.
  - Each argument left off takes its parameter's default. Each default is fixed at load, so leaving an argument off costs no Fuel beyond passing the value. Chapter 8 gives the lowering.
  - A Function Value made from a named function (`map(xs, double)`) accepts the same range of argument counts. A call outside that range raises `wrong arity`, as a Lambda call with the wrong count does.
- **The stdlib:** each optional argument of a stdlib Library function is written as a default, and chapter 7 lists it that way. Built-ins, which the Cores implement natively, follow the same notation in chapter 7 (`round(x, places = 0, mode = "half up")`).
- **Not affected:** Handlers, Lambdas, Handler Clauses, Command Calls and Capability Operations, which keep fixed argument counts or their own Shapes.
