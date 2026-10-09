# A `whose` clause picks the chunks whose condition holds

A Chunk Expression may end with a Whose Clause, `whose c`, which keeps only the chunks for which `c` is `true`. Inside `c`, `it` is the chunk being tested. `every item of orders whose the amount of it > 100 GBP` gives the list of matching elements. `the first item of tickets whose the status of it is "open"` gives the first match, or Nothing when there is none. Any ordinal works this way, and `last` gives the last match. For example:

```
put every item of orders whose the amount of it > 100 GBP into big
put the first item of tickets whose the status of it is "open" into next
put every line of report whose the length of it > 80 into long
```

We chose this because filtering is one of the first things a beginner needs, and today it takes a Library import and a Lambda: `use filter from list`, then `filter(orders, given o: the amount of o > 100 GBP)`. Chunk Expressions are already Beginner Surface (`the first word of s`, `the last line of report`), and a Whose Clause only adds a condition to them. It is HyperTalk's and AppleScript's spelling (`every window whose visible is true`), which many of the language's readers know.

This narrows ADR 0025, which removed Comprehensions as a second spelling of `map` and `filter`. A Whose Clause isn't the removed Comprehension. It binds no name, maps nothing, sorts nothing and accumulates nothing. It only picks chunks, and its condition may call only Built-ins, so a test that needs Script code is still `filter`'s job. The removed `every r in xs where g` was a general loop form, but this is a narrower condition on a construct that already exists. ADR 0025 also rejected an implicit `it` parameter for Lambdas, because nothing marked where the Lambda began. Here `whose` marks where the condition begins, and `it` already means "the thing at hand", as it does after `ask`. Settled in #525.

## Considered Options

- **Bare key names, as AppleScript has** (`whose amount > 100 GBP`): this reads best, but `amount` could be a local, a Script Variable, a Constant or a Built-in property such as `length`, and nothing in the source would show which one it is. One rule would make a key shadow the local, which silently changes what a name means inside the clause. Another would make a name that is both a key and a local a load error. That breaks a Script when a map gains a key, and the loader can't know a map's keys anyway.
- **An explicit name** (`whose each …`, `whose o: …`): `each` already has a meaning after `repeat for`. A named form brings back the Comprehension's binding, and once it has a name, a Lambda is the better tool.
- **`where` in place of `whose`:** `where` is already reserved, so no source would break. But `where` is the Guard's word and was the removed Comprehension's spelling. Inside a Guard, `the first item of xs where …` would read as a second Guard.
- **Any expression as the condition:** a Whose Clause would then do every job `filter` does, which is the two spellings ADR 0025 rejected. Limiting the condition to Built-ins keeps each job to one spelling. A test on the chunk's own data is a Whose Clause, and a test that needs Script code is `filter`, or `repeat … collecting` with `next repeat` (ADR 0059).
- **Exactly a Guard's rules**, including its pure key reads on Host Objects: a Guard has those rules because clause selection has no Run in which to call the Host. A Whose Clause runs in its Run, so `every item of windows whose the visible of it is true` may read Host properties, as any expression there may.
- **A Guard's error handling,** where an error in the condition skips the chunk: an error in a Guard can't be raised because there is no Run to raise it in, and skipping is how clause selection then carries on. A Whose Clause has a Run. Skipping would hide a misspelt key, which reads as Nothing anyway, behind a silently shorter list.
- **Text results for text chunks** (`every line of s whose …` joined with `newline`): words and Characters have no single delimiter to join with, and a list is what `the lines of s` already gives. One rule for every kind is simpler: the result is the plural property, filtered.
- **Writing through a Whose Clause,** as AppleScript allows (`set every item of xs whose … to 0`): with value semantics, `put` into a set of scattered chunks has no single place to write, and a write to an ordinal match would need the match's position. Read-only is simpler, and a `repeat for each` covers the writes.
- **A clause that may sit inside any operand,** as a Chunk Expression can: `the length of every item of xs whose it > 1` would read without brackets. But because comparisons don't chain, an operator left after the condition would attach outside it, so `whose it > 3 is empty` would test emptiness of the result while `whose it is empty` tests each chunk.
- **Only `first` and `last`:** the issue named those two, but every ordinal is already a chunk position. `the second line of s whose …` means the second match, and is no harder to read.
- **`every item of xs` without `whose`:** that is `the items of xs`, which already exists. Requiring the clause keeps one spelling.
- **An Advanced tag:** under ADR 0027's test, `filter` with a Lambda does the same job, but a beginner can guess what `whose` means, so the clause isn't Advanced.
- **A Lint only, suggesting `filter`:** the beginner would still need a Library import and a Lambda for the commonest list task.

## Consequences

- **Syntax:** narrows ADR 0019.
  - At the start of an expression, `every` followed by a singular chunk word, or by `code`, starts an Every Head: `every item of xs`. An Every Head must be followed by a Whose Clause. This is a new second-token decision, `every-chunk`. `every` followed by `match` still starts a Match Search, and any other `every` is a Name.
  - An ordinal Chunk Expression that is a whole operand (`the first item of xs`), with or without its `delimited by`, may also be followed by `whose c`. `whose` after any other operand is a syntax error.
  - A Whose Clause is a whole Expression, as a Lambda is (`Expression ::= Lambda | EveryHead Whose | Or Whose?`). `c` is an Expression too, so it runs to the next top-level comma, closing bracket, `into`, `then` or end of line. Inside an operand the clause needs brackets: `the length of (every item of xs whose it > 1)`, and `(the first item of xs whose it > 3) is empty`. Without them, `if the first item of xs whose it > 3 is empty then …` is a syntax error at `is`, because comparisons don't chain. It never quietly becomes `(… whose it > 3) is empty`, which a clause that may sit inside an operand would make it.
  - `whose` is a contextual keyword, and it joins the FOLLOW set. No Unit is named `whose`.
  - A Whose Clause isn't a Container. `put 1 into the first item of xs whose …` is a syntax error at `whose`, and `put 1 into every item of xs whose …` is one at `item`.
- **What it reads:** `every K of x whose c` walks `the Ks of x`, the plural property of the chunk kind `K`, with the chain's `delimited by` if there is one. So the walk is over the elements of a list, the integers of a range, the items, lines, words or Characters of text as texts, or the bytes of Bytes as numbers. Any other value raises `wrong kind`, as the property does.
- **Results:**
  - `every …` gives a new list of the chunks for which `c` is `true`, in order, and `[]` when there are none. It is a list even for chunks of text.
  - `the n-th …` gives the n-th match, and `the last …` the last one. Each gives Nothing when there is no such match, for text too, so the empty text a matching empty line gives is told apart from no match.
- **The condition:**
  - `it` is the chunk being tested. Every other name resolves as it does outside the clause. The body's own `it` can't be read inside the clause. A nested Whose Clause has its own `it`.
  - `c` must give a boolean. Any other value raises `wrong kind` with `expected` `"boolean"`, as an `if` condition does.
  - An error in `c` is raised in the Run, as any other expression's error is.
  - `c` may call only Built-ins, and may not hold a Lambda. A call to a Script or Library function, a Handler or a Function Value, including one through a name that shadows a Built-in, is the new load error `not in a whose`. Keys, Built-in properties and Host Object properties are read as anywhere else in a Run.
- **Order and stopping:** the chunks are tested in order, over a snapshot taken when the walk starts. `the n-th …` stops at its n-th match, so `c` is never evaluated on the chunks after it. `the last …` and `every …` test every chunk.
- **Lowering:** narrows ADR 0010. No new instruction is needed.
  - `every K of x whose c` lowers to: `list 0` `store r`, then ⟦x⟧ and `property` of `K`'s plural (or `property-delimited items`), then `iterate`. L1: `next L2` `store t`, ⟦c⟧ `branch-false L1`, then `load r` `load t` `list-append` `store r` and `jump L1`. L2: `pop` `load r`.
  - The ordinal forms start with `const nothing` `store r` and replace the append. For `first`, a match does `load t` `store r` `jump L2`. For `last`, it does `load t` `store r` `jump L1`. For `second` to `tenth`, a counter `k` that starts at n is counted down on each match, and the match that brings it to 0 does `load t` `store r` `jump L2`.
  - Inside `c`, `it` is `load t`. Every step is charged as its instructions are (ADR 0021).
- **Surface:** Beginner Surface, with no `[[advanced]]` tag (ADR 0027).
- **Tooling:** a `suggest-whose` hint, at the `beginner` level, for a `filter` call whose Lambda has one plain parameter and a body that would be a valid condition. It ships with the Cores' implementation. Adding it isn't a language change.
- **Delivery:** the rules land with this ADR (ADR 0032): the grammar in chapter 2, `grammar.ebnf` and `grammar.toml`, chapters 4 and 8, `diagnostics.toml`, and the reference parser with its sketch and broken cases under `tools/grammar/whose/`. The examples stay in plain code blocks until both Cores parse them, since the TS Core's tests parse every `talk` block in `docs/` and `spec/`. The implementation follow-up supplies both Cores' parsers, checkers and lowerings, the Disassembly and Trace Cases, and the Lint. Its cases cover maps, text chunks, no match, the ordinal and `last` forms, `not in a whose`, and a local named like a key, which the clause doesn't read.
- **A breaking change, with no version bump.** A chunk index that is a variable named `whose`, as in `item whose of xs`, no longer parses and needs brackets: `item (whose) of xs`. No source in the corpus, the stdlib or the docs is affected.
