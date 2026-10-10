# A pipeline operator compared with temporary variables

Research for [#580](https://github.com/odogono/odgn-talk/issues/580), checked
2026-10-10 against repository revision `0701253a`. This is evidence for a
decision, not an accepted ADR or implemented behavior. The piped forms below are
hypothetical syntax that no Core parses, so they are fenced as `text` rather
than `talk`, which the grammar check parses.

## Recommendation

The pipe fails the decision rule: it beats the temporary-variable form on 2 of
the 5 samples, short of the 3 the rule asks for. Close #580 as `wontfix` and link
this note, so a later proposal starts from these samples rather than from
scratch.

The pipe does win where a chain of whole-list calls feeds one value through.
Mixed-direction sorts are the clearest case. It loses where Talk's own idioms
take over: Whose Clauses and chunks aren't calls, so they can't be steps. A step
that may suspend has to be a `repeat`. And a value used twice needs its name
anyway.

## The decision rule

Each sample is written three ways:

- **Nested:** calls inside calls, as the issue describes.
- **Temporary variables:** `put … into` one step at a time, the style the
  corpus already uses.
- **Piped,** in two spellings: `|>`, and the English word `through`.

The pipe moves to design only if it beats the temporary-variable form on at
least 3 of the 5 samples. "Beats" means three things together: fewer lines, no
invented variable names, and the same or better clarity for a beginner. A sample
where a swallowing trap forces brackets counts against the pipe. Matching the
temporary-variable form doesn't count as beating it.

The rule and the sample were fixed before any rewriting was done.

## The corpus

- **Nesting.** Of 598 `.talk` files, only 26 lines nest a call as the first
  argument of another call (`f(g(`). Only one of them chains collection
  functions: `join(map(rows, …), "|")` in `corpus/stdlib/calls/report.talk:21`.
  The rest are scalar helpers like `trimEnd(trimStart(t))` and
  `round(sin(r), 4)`. The Spec adds one more:
  `sortBy(sortBy(rs, temp, "descending"), city)` in
  [chapter 7](../../spec/07-libraries-and-the-standard-library.md#sorting).
- **Temporary variables.** About 20 places `put` a call's result into a
  variable and pass it to another call within three lines. Only 4 of those are
  collection chains.
- **Collection calls are rare.** `filter`, `map`, `sortBy`, `sortWith`,
  `reduce`, `partition` and `group` are called 35 times in the whole corpus.
  By contrast, `repeat … collecting` appears on 65 lines.
- **The bias.** The language's authors wrote the corpus, knowing how nested
  calls read. That is why sample 5 was written fresh for this note.

## What a pipe would meet in the grammar

These facts shaped the rewrites:

- **The callee must be a call.** As in Elixir, `a |> f(b)` means `f(a, b)`.
  Command Calls, `ask`, `tell`, `send` and `f(x) and wait` are statements, not
  expressions ([chapter 2](../../spec/02-grammar.md)), so none of them can be a
  pipe step.
- **Lambdas are safe inside a step.** The body of `given p: …` runs to the next
  top-level comma or `)`, and both close the step's call. So
  `xs |> filter(given p: the active of p) |> map(…)` parses as intended.
- **Whose Clauses swallow.** A Whose Clause is a whole expression whose
  condition runs at the lowest precedence. In
  `every item of xs whose active |> sortBy(…)`, the `|>` would become part of
  the condition. It needs brackets: `(every item of xs whose active) |> …`.
- **Chunks and properties read right to left.** `items 1..3 of xs` and
  `the name of p` aren't calls, so a chain has to stop for them.
- **Line continuation.** A trailing `|>` would continue the line, as any
  symbol operator does
  ([chapter 1](../../spec/01-lexical-structure.md#lines)). `through` would need
  to join the listed words. A line that *starts* with the operator, as in
  Elixir, never continues the line before it.
- **Tokens.** `|` is a `bad character` today, so `|>` needs a lexer change in
  both Cores. `through` is an ordinary Name, so it would need an
  operator-position decision like ADR 0075's `does` and `comes`.
- **Argument order.** The stdlib takes the subject first almost everywhere.
  The exceptions are `offset(needle, s)` and `lastOffset`, which keep
  HyperTalk order, and `format(template, values)`.

## The samples

### 1. Split, sort, pad and join

From `corpus/stdlib/calls/report.talk:19-21`. In that case `rows` and `line`
are Script Variables, which the case observes, but this comparison treats them
as locals.

Temporary variables, 3 lines and 2 names:

```talk
put split("b:2,a:1,c:3", ",") into parts
put sortBy(parts, given p: item 2 of split(p, ":")) into rows
put join(map(rows, given p: pad(p, 5, ".")), "|") into line
```

Nested, 1 line, read inside out:

```talk
put join(map(sortBy(split("b:2,a:1,c:3", ","), given p: item 2 of split(p, ":")), given p: pad(p, 5, ".")), "|") into line
```

Piped, 4 lines and no names:

```text
put "b:2,a:1,c:3" |> split(",") |>
    sortBy(given p: item 2 of split(p, ":")) |>
    map(given p: pad(p, 5, ".")) |>
    join("|") into line

put "b:2,a:1,c:3" through split(",") through
    sortBy(given p: item 2 of split(p, ":")) through
    map(given p: pad(p, 5, ".")) through
    join("|") into line
```

**Verdict: doesn't beat.** The pipe removes both names. On one line, though,
it runs to 130 characters, and wrapped it takes more lines than the
temporary-variable form. Inside the sort key, `item 2 of split(p, ":")` stays
read right to left, because the chunk can't be a pipe step. The line `split` →
`sortBy` → `map` → `join` reads better than the nested form, but it isn't
clearer than three named steps.

### 2. Map, reduce, average and max

From `tools/grammar/sketch/09-http-fetch.talk:79-86`.

Temporary variables:

```talk
put map(clean, given r: the temp of r) into temps
put reduce(temps, given total, t: total + t, 0) into sum
put average(temps) into mean
put max(temps) into warmest
```

Piped:

```text
put clean |> map(given r: the temp of r) into temps
put temps |> reduce(given total, t: total + t, 0) into sum
put temps |> average() into mean
put temps |> max() into warmest
```

**Verdict: doesn't beat.** Three calls read `temps`, so the name stays. The
pipe only moves each subject from inside the parentheses to the front, and adds
an empty `()` to `average` and `max`. The nested form doesn't arise.

### 3. Rank, then report the winner and the names

From `tooling/playground/src/examples/collections/lambdas.talk:13-15`.

Temporary variables:

```talk
put sortBy(players, given p: the score of p, "descending") into ranked
say "winner: " & the name of item 1 of ranked
say "names: " & map(ranked, given {name: n}: n)
```

Piped:

```text
put players |> sortBy(given p: the score of p, "descending") into ranked
say "winner: " & the name of item 1 of ranked
say "names: " & (ranked |> map(given {name: n}: n))
```

**Verdict: doesn't beat.** Two lines read `ranked`, so the name stays. If `|>`
binds more loosely than `&`, the last line needs brackets. If it binds more
tightly, then `a + b |> f()` pipes only `b`. Either way a precedence rule
becomes something a beginner has to learn.

### 4. A sort by two keys

From [chapter 7](../../spec/07-libraries-and-the-standard-library.md#sorting).
It sorts by city, then by falling temperature, as two stable sorts with the
main key last.

Nested, read in the opposite order to how the sorts run:

```talk
put sortBy(sortBy(rs, temp, "descending"), city) into sorted
```

Temporary variables:

```talk
put sortBy(rs, temp, "descending") into byTemp
put sortBy(byTemp, city) into sorted
```

Piped:

```text
put rs |> sortBy(temp, "descending") |> sortBy(city) into sorted
put rs through sortBy(temp, "descending") through sortBy(city) into sorted
```

**Verdict: beats.** It takes 1 line and no extra name, and the sorts read in
the order they run, which is the order the stable-sort rule explains. This is
the pipe's strongest case.

The same chapter's `summarise` example is filter → sortBy → map, through the
names `gusty` and `hottest`, each used once. It counts the same way. It isn't
scored, since the five samples were fixed before the rewriting started:

```text
put readings |> filter(given r: the wind of r > 10) |>
    sortBy(given r: the temp of r, "descending") |>
    map(given r: the city of r) into cities
```

### 5. Invite the top three active players

Written for this note. Each invitation asks the person running the Script
([ADR 0077](../adr/0077-user-is-an-optional-standard-capability-that-asks-the-person-running-a-script.md)),
so that step may suspend. The REPL confirmed the nested selection gives
`["Di", "Ann", "Cy"]` on a four-player list. The `ask` loop wasn't run, because
it needs a person to answer.

Nested, for the part a call can express:

```talk
put map(items 1..3 of sortBy(filter(players, given p: the active of p), given p: the score of p, "descending"), given {name: n}: n) into names
```

Temporary variables, using a Whose Clause and `repeat … collecting`:

```talk
put every item of players whose active into active
put sortBy(active, given p: the score of p, "descending") into ranked
repeat for each p in items 1..3 of ranked collecting the name of p into invited
  ask user to confirm "Invite " & the name of p & "?" and wait
  if not it then next repeat
end repeat
```

Piped:

```text
put (every item of players whose active) |> sortBy(given p: the score of p, "descending") into ranked
repeat for each p in items 1..3 of ranked collecting the name of p into invited
  ask user to confirm "Invite " & the name of p & "?" and wait
  if not it then next repeat
end repeat
```

**Verdict: doesn't beat.** It saves one name, but the Whose Clause needs
brackets, which counts against the pipe by the rule. Taking three is a chunk,
so it isn't a step. The invitation can't be a `map` step at all: a Lambda that
asks may suspend, and it would raise `would suspend` inside `map` (ADR 0025).
So the chain stops at the step a beginner most needs to write.

## Tally

| Sample | Fewer lines | No extra names | Clearer | Trap | Beats |
| --- | --- | --- | --- | --- | --- |
| 1. Split, sort, pad and join | no (4 against 3) | yes | no | none | no |
| 2. Map, reduce, average and max | no | no | no | none | no |
| 3. Rank and report | no | no | no | `&` precedence | no |
| 4. A sort by two keys | yes | yes | yes | none | **yes** |
| 5. Invite the top three | no | partly | no | Whose Clause | no |

Counting sample 1 for the pipe, as its one-line form would, gives 2 of 5. That
is still short of 3.

## If this is reopened

Questions that only matter for a later proposal:

- **Precedence** against `&` and the arithmetic operators. The choice decides
  whether sample 3's brackets go away or appear somewhere else.
- **The Whose Clause:** does `|>` end its condition, as `,` ends a Lambda
  body?
- **Where `at` points:** at the step's call name, as calls are positioned
  today, or at the `|>` token.
- **The spelling.** `|>` needs a new token in both Cores. `through` needs an
  operator-position decision and a place in the line-continuation list.
- **Lowering:** whether it keeps to "no new instruction, no new Fuel", as ADR
  0075 did. Ordinary calls write no Trace record, so a pipe that lowers to
  `f(a, b)` would leave the Trace unchanged.

New evidence would be a body of Scripts written by people other than the
language's authors, where nesting and single-use temporary variables are
common.
