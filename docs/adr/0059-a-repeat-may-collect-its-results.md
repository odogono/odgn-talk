# A `repeat` may collect its results

A `repeat` head may end with `collecting e into v`: `repeat for each r in rows collecting the name of r into names`. The loop puts `[]` into `v` when it starts, and at the end of every pass that finishes, it adds the value of `e` to `v` as one element. `next repeat` and `exit repeat` skip that pass's value, so `next repeat` filters. We chose this because a beginner who builds a list today has to start it with `put [] into acc`, since `put x after` raises `wrong kind` on Nothing. They then have to tell `put xs after acc`, which nests a list, from `put ...xs after acc`, which splices one. The alternative, `map` and `filter` with a Lambda, doesn't cover every loop: a Lambda that may suspend raises `would suspend` inside them (ADR 0025), so a loop that waits for each element must be a `repeat`, and it had no tidy way to build its result. This narrows ADR 0025, which removed Comprehensions as a second spelling of `map` and `filter`: the clause is the loop's own way to collect, for the loops that only a `repeat` can write. Settled in #368.

- **One word, one clause.** `collecting` is the only accumulating word, and a loop has at most one clause. A sum, a count or a maximum is `sum(xs)`, `the length of xs` or `max(xs)` of the collected list.
- **Every head takes it:** `for each`, `while`, `until`, `forever` and `e times`.
- **The target is a fresh local.** `v` is a plain Name, and the loop is the only thing that writes it. It is `[]` even when the loop runs no passes, and it is set before the head is evaluated, so `repeat until the length of picks = 3 collecting … into picks` reads the list so far.
- **The body may read the target but not write it.** A Container rooted in it, a pattern that binds it, or an inner loop that collects into it is `can't write`. A target named like a Script Variable, a Constant, a well-known object or a name the loop's own pattern binds is `name clash`, as a pattern binding is.
- **A pass that doesn't finish collects nothing.** After an error leaves the loop, the target holds the values collected before it, as a hand-built list would.

## Considered Options

- **Lints only:** a Lint that suggests `filter` and `map` for a filter-then-append loop, and one that flags `put xs after acc` nesting a list. Neither helps the loop that waits for each element, which has no Library spelling.
- **Letting `put x after` a Nothing local start a list:** it removes the `put [] into acc` line, but a misspelt Container would then quietly become a list, and the nesting trap stays.
- **`summing`, `counting`, `maximizing` and `minimizing`,** as Common Lisp's `loop` has: each is one call on the collected list, and `summing` would need a starting value. `0 + 5 kg` raises `wrong kind`, so it would have to start from the first value, as `sum` does, and pick an answer for an empty loop.
- **Appending to an existing target:** the loop would raise `wrong kind` unless the target already held a list, which brings back the `put [] into acc` line it exists to remove.
- **Any Container as the target,** such as a Script Variable or `the names of report`: the body could write the same Container through another name, and the loop would no longer be the only thing that writes its target.
- **Collecting at the start of a pass:** `next repeat` could no longer filter, and the value couldn't depend on what the body computed.
- **Collecting on `exit repeat` too:** `exit repeat` would then mean "keep this one and stop", unlike `next repeat`, and a loop that searches would collect the value it stopped at.
- **`for each` only:** `repeat 3 times collecting random(6) into rolls` and a `repeat forever` that reads until it is done are as natural, and the parse is the same for every head.
- **Several clauses in one loop:** two results from one walk are `partition`'s job, or two `put … after` lines.
- **Leaving it at `map` and `filter`** (ADR 0025): the Lambdas are Beginner Surface, but the loop that suspends can't use them.

## Consequences

- **Syntax:** `Repeat` takes an optional `Collecting ::= 'collecting' Expression 'into' Name` after its head.
  - `collecting` is a contextual keyword, and it joins the FOLLOW set, so `repeat for each c in item collecting …` reads `item` as a Name, not a chunk.
  - `into` is reserved and isn't an operator, so it ends the expression, as in `put`. No Unit is named `collecting`.
  - No new two-token decision is needed. A source that used `collecting` as a chunk index straight after a chunk word, such as `item collecting of xs`, now needs brackets: `item (collecting) of xs`.
- **Surface:** Beginner Surface. It has no `[[advanced]]` tag.
- **Lowering:** no new instruction.
  - The loop starts with `list 0` and the target's `store`, before its head.
  - Each pass that finishes ends with the target's `load`, ⟦e⟧, `list-append` and the target's `store`, just before the jump back to L1.
  - `next repeat` jumps to L1 and `exit repeat` to L2 as before, so both skip it. The collecting is charged as those instructions are (ADR 0021).
- **Errors:** no new code. `can't write` and `name clash` gain the target's rules.
- **Tooling:** a beginner `suggest-collecting` hint, for a loop that a `put [] into acc` comes straight before and that puts into `acc` with `put … after`, ships with the Cores' implementation. A Lint for `put xs after acc` that nests a list is a separate question.
- **Delivery:** the rules land with this ADR (ADR 0032): the grammar in chapter 2 and `grammar.ebnf`, `grammar.toml`'s FOLLOW set and contextual row, chapters 4 and 8, and `diagnostics.toml`. The implementation follow-up (#380) supplies both Cores' parsers, checkers and lowerings, their corpus cases and the Lint. Its shared parser cases live in `tools/grammar/sketch/collecting.talk` and `tools/grammar/broken.talk`, and its reference lowering cases in `tools/machine/lowering.talk`. Current support is described in the Core guides; first-blessing evidence is in [the review record](../reviews/collecting/README.md).
- **A breaking change, with no version bump.** `item collecting of xs`, a chunk whose index is a variable named `collecting`, no longer parses, so the change is marked breaking. The language stays `1.0-rc.2` because it is still unreleased, and no source in the corpus, the stdlib or the docs is affected.
