# Findings: do ADR 0025's Lambdas hold up in the grammar and on the page? (issue #54)

**Verdict: yes, with narrowing.** A reserved `given`, its parameter list and both Lambda forms parse predictively, with no backtracking, no relexes and no new second-token decisions. Once Comprehensions are removed, all 12 sketch files parse (the 11 originals plus the new `12-lambdas.talk`). One lexer rule had to change for block Lambdas, and four rules need to go into ADR 0025 ([§4](#4-proposed-narrowing-notes-for-adr-0025)). Readability is mixed. Single-line filters, maps and folds read about as well as the Comprehensions did. Sorting reads worse, and so do block Lambdas written inline as arguments ([§3](#3-readability-before-and-after)). Nothing here sends ADR 0025 back to grilling.

How this was checked: the #38 parser, extended on this branch. `peek(2)` still throws, and every second-token decision is still counted. Run from the repo root:

```sh
bun prototypes/parser-sketch/run.ts            # 12/12 files, LL(2) report
bun prototypes/parser-sketch/run.ts --broken   # the #54 cases are at the end
bun prototypes/parser-sketch/run.ts --check-table
```

## 1. Lookahead

- **`given` is decided on its first token.** It is reserved, so in operand position it always starts a Lambda. `lambda()` never calls `la2`, and the report has no Lambda site.
- **The head.** The parameters are `pattern()`s separated by commas, the same Destructuring parser that Handler heads and `let` use. The head ends at `:` (the expression form) or at the end of the line (the block form). A zero-parameter Lambda is `given: 42`, or `given` alone at the end of a line. Map patterns (`given {temp: t}: …`), kind tests (`given s is a text: …`) and `as` bindings all parse, because their own `:` sits inside `{…}` or comes after a finished pattern.
- **The body.** An expression body is an `expr()`, so it has the lowest precedence. It ends at the first token that can't continue an expression: a top-level `,`, a closing bracket, `into`, `then` or `else`. So `map(xs, given r: r * 2, 2)` passes `2` to `map`, and `given r: r > 1 and ok` takes `and ok` into the body. Both are in `broken.talk` as "parses, but".
- **Lambdas inside Lambdas and inside literals.** `given k: given x: x * k`, `[given r: r, given … end given, 3]` and `{f: given r: r, g: given: 2}` all parse.
- **Removing Comprehensions frees two decision sites,** `for-every` and `sorted-by`, and `every` now only has to tell `every match of` from a name. `sorted`, `ascending` and `descending` leave the FOLLOW set.

**Relexes: 0. Lookahead beyond two tokens: none.**

## 2. What had to change

- **Newlines in block Lambdas.** ADR 0019 continues a line while a bracket is open, so the lexer used to skip every newline inside `filter( … )`. A block Lambda passed as an argument then loses its newlines: nothing ends its head, and nothing separates its statements. The fix is data the parser already has. The parser keeps a stack of "newline base" depths. A Lambda head pushes the current bracket depth, and so does a block body. A newline is skipped only while more brackets are open than that base, or after a trailing operator or comma. So inside `filter(readings, given r ⏎ … ⏎ end given)` the newlines count, while a list opened inside the body (`[x, ⏎ y]`) still continues. Because the push happens when `given` is consumed, the mode is always known in time: no relexes.
- **A reserved `given` in Container position** fails at once: `put 1 into given` reports "a Container" at `given`. Without this, the Container parse starts a Lambda, and the error shows up lines later at whatever follows the unclosed block. This is a small case of ADR 0019's open question, whether "not a Container" is a syntax error: for `given`, it has to be.
- **`and wait` on call statements.** `f(x) and wait` and a Command Call's `name args and wait` (from ADR 0020, which the #38 parser predates) now parse as statements, and the result goes in `it`.
- **`grammar.toml`:**
  - `given` is added under `[reserved] lambda`.
  - The `comprehension` group becomes `match_search`, holding `every`.
  - The FOLLOW set drops `sorted`, `ascending` and `descending`.
  - The `sorted_by` modifier is gone.
  - `and_wait` now attaches to Command Calls and call statements too.
  - The generator checks still pass.

## 3. Readability, before and after

These examples are from `09-http-fetch.talk`, the only original sketch file with Comprehensions, and from the new `12-lambdas.talk`.

| Task | Before (ADR 0019) | After (ADR 0025) | Verdict |
| --- | --- | --- | --- |
| filter | `every r in clean where the wind of r > 30 km/hr` | `filter(clean, given r: the wind of r > 30 km/hr)` | about even: the verb comes first, and `given r:` names the element as `every r in` did |
| map | `the temp of r for every r in clean` | `map(clean, given r: the temp of r)` | after is better: the source comes before the projection |
| sort | `every r in clean sorted by the wind of r descending` | `sortBy(clean, given r: the wind of r, {descending: true})` | before is better: `descending` becomes an options map |
| group | not possible (#47) | `group(clean, given r: the date of the at of r)` | new |
| fold | a `repeat` loop and an accumulator | `reduce(temps, given total, t: total + t, 0)` | new, and for beginners the loop is arguably clearer |
| Collation sort | `every r in rs sorted by the (the name of r) of ranks` | `sortBy(rs, given r: the (the name of r) of ranks)` | about even |
| named predicate | not possible | `filter(readings, isWindy)` | new, and reads best of all |
| stored callback | not possible | `put given url ⏎ … ⏎ end given into statusOf` | new, and reads well as a statement |
| inline block Lambda | not possible | `filter(readings, given r ⏎ … ⏎ end given) into gusty` | parses, but `end given) into gusty` is ugly |

What this suggests (lints, not grammar):
- A lint could prefer naming a multi-line Lambda (`put given r … end given into isGusty`) over writing it inline as an argument.
- `sortBy` might take `descending` as a separate function (`sortByDescending`) or a trailing word instead of an options map. That is a Library-shape question, not a grammar one.

## 4. Proposed narrowing notes for ADR 0025

1. **Block Lambdas and newlines:** a Lambda head and a block Lambda body make newlines significant again at the bracket depth where they start. So a block Lambda can be an argument, a list item or a map value. Inside it, brackets opened in the body continue lines as usual.
2. **An expression body can't suspend:** `ask … and wait`, `wait` and `f(x) and wait` are statements. So a Lambda that may suspend is always the block form, and a may-suspend thunk is `given ⏎ … ⏎ end given`.
3. **`and wait` is statement-only:** a call that may suspend is a statement, `f(x) and wait`, with the result in `it`, as with `ask`. `put f(x) and wait into y` is a syntax error at `and`.
4. **Calls need a name:** `name(` is the only call form, so `times(3)(14)` is a syntax error at the second `(`. A Function Value held in a key, or returned by a call, is put into a variable first.
5. Also: `given` in Container position is a syntax error at `given`, and zero parameters are written `given: e`.

## 5. Left open

- **The checker, not parsing:**
  - that captured locals are read-only;
  - that `pass`, `exit` and `the target` aren't used inside a Lambda;
  - that a name isn't both a variable and a function;
  - the may-suspend flag;
  - `and wait` on Command Calls to Handlers that call Function Values (`fire` in `12-lambdas.talk` has to be `fire … and wait`, which the loader can see).
- **The Library's shape:** how `sortBy` spells descending order, and whether `any`, `all`, `count` and `partition` join `filter` and `map`.
- **Whether a Command Call can take a Function Value in first position,** e.g. `fn payload` for a variable `fn`. The #38 rule makes a leading non-reserved word a Command Call to a *Handler*, so `fn(payload)` is the only spelling.
