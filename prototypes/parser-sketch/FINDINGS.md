# Findings: does ADR 0019 hold up against the syntax sketch? (issue #38)

**Verdict: yes, with narrowing.** All 11 [syntax-sketch](../syntax-sketch) files, updated to the ADR 0019 spellings, parse predictively with no backtracking and never more than two tokens of lookahead. The parser always knew the lexer mode in time, and first-error positions are well defined. But the ADR's rules aren't enough on their own to stay at two tokens. The parser needed about a dozen more, listed in [§7](#7-proposed-narrowing-notes-for-adr-0019). The reserved list also comes out longer than the ADR's example list, and slightly different ([§5](#5-grammartoml-first-draft)).

How this was checked: `parser.ts` has no mark/reset, a `peek(2)` throws, and every decision that reads the second token goes through `la2(site)`, which counts it. Every peek names the lexer mode. If a buffered token is later needed in another mode and lexes differently, the parser records a relex. Run `bun prototypes/parser-sketch/run.ts` to reproduce the numbers below.

## 1. Lookahead

No construct needed a third token. 26 decision sites use the second one:

| Site | Count | The rule it implements |
| --- | ---: | --- |
| `map-key` | 190 | `{word: …}`: a word followed by `:` is a key (in patterns, a bare word is shorthand `{n}`) |
| `capture` | 56 | `<name: …>`: a word followed by `:` is a Capture |
| `and-wait` | 55 | `… and wait` ends the argument or target expression of `send`/`ask` |
| `the` | 50 | after `the`: ordinal + chunk word, `target` without `of`, `match of`, `code points` |
| `chunk-word` | 26 | `line 3 of r` vs a variable `line`: the chunk word is followed by an index-start token |
| `binary-field` | 22 | `<< name: type >>` vs a literal field |
| `ignoring-case` | 6 | `ignoring case` after a comparison, a `match` or a pattern element |
| `is-a` | 5 | `x is a number` vs `x is a` (a variable `a`) |
| `delimited-by` | 5 | `delimited by` after a chunk |
| `code-point` | 5 | `code point`/`code points` as one chunk kind |
| `script-variable` | 4 | `script variable` at top level |
| `as-in-binary-build` | 4 | inside `<< >>`, `as uint16` is the field type, not a conversion |
| `date-literal` | 3 | `date 2026-09-27`: the second token is lexed in date mode |
| `pattern-as` | 3 | `on handle {…} as refund` |
| `every` | 3 | `every r in xs` / `every match of` vs a variable `every` |
| `can-be`, `count-form`, `when-contains`, `head-every-time`, `date-at`, `begins-with`, `replace-first`, `wait-from`, `for-every`, `sorted-by`, `head-during` | 1–2 each | see `parser.ts` |

**Relexes: 0.** For every two-token decision, the mode of the second token is fixed before the decision is made. The one site where that mode changes the token is `when contains <…>`, and there the second token is in operand position under both readings. Two early relexes were prototype bugs, where the parser peeked a Handler head and `return`'s operand in operator mode. They're a reminder that optional operands must be peeked in operand mode.

**What keeps it at two tokens.** Each item here is a rule the ADR doesn't state:

- **Statement keywords are reserved.** If `add` were contextual, `add 1 to x` and a Command Call `add 1` would differ only at `to`, arbitrarily far in. The same goes for every statement keyword (`set`, `delete`, `replace`, `exit`, `pass`, `throw`, `wait`, …). So none of them can be a Handler name.
- **`in` is reserved.** Otherwise `x is in r` (membership) and `x is in` (equality with a variable `in`) are a three-token decision.
- **`wait` is reserved.** `… and wait` is then decided on `and` plus one token, and never reads as a boolean `and` with a variable `wait`.
- **`after` is reserved.** It ends a `wait for` branch at statement start, so a Command Call to an `after` Handler inside one would be misread.
- **Chunk words use a FOLLOW set.** A chunk word followed by a token that can start an index (a number, text, `(`, `[`, `-`, or a name) is a chunk. Words that may follow a finished expression (`as`, `mod`, `contains`, `ignoring`, `delimited`, `with`, `from`, `by`, `times`, …) are never an index. That set is now data in `grammar.toml`. The cost: `put line - 1 into x` with a variable `line` reads `line -1 of …` and fails at `into` (see `broken.talk`).
- **Handler-head modifiers aren't parameter names.** After a comma in a head, `replacing`, `dropping`, `queued` and `deciding` are modifiers, and `every time` and `during msg` are decided on their second word. So `on search term, replacing` can't mean a parameter called `replacing`.
- **`from` in `wait for` takes a postfix-level operand.** Otherwise `wait for click from okButton or 30 s` reads `okButton or 30 s` as a boolean.
- **Inside `<< >>` builds, `as <integer type>` ends the value.** It's decided on `as` plus the type word, so `<< the length of b as uint16, b >>` needs no parentheses.
- **A kind after `is a`, `can be` or `as` is any word except a Reserved Word.** Without that, `if x is a then …` reads `then` as a kind.

**The one backtracking-shaped rule is at the REPL** (ADR 0014): "an Entry that doesn't parse as a statement but does parse as an expression echoes its value". Read literally that's two parses. It's also wrong for `n - 1`, which parses as a statement: a Command Call to `n` with the argument `-1`. The fix generalises the ADR's lone-word rule. An Entry that starts with a non-reserved word is a Command Call if the Session Script has a Handler by that name, and an expression otherwise. That's decided on the first token, with no second parse.

## 2. The #36 collisions

| Collision | Status | Notes |
| --- | --- | --- |
| Unit suffixes vs names (`put 5 s into s`) | settled | Literal + catalogue word. Needs one more rule: compound Units have no spaces (`60 mi/hr`), and a spaced `/` is division (`500 mi / 4 hr`). `3..7 m/s` is `3..(7 m/s)`, so the sketch now writes `3 m/s..7 m/s`. |
| `<` as less-than, Text Pattern and `<<` | settled | By the operand/operator split. Inside `<…>` the lexer must lex `>` one at a time, so `<one or more of <letter or digit>>` closes twice. |
| `name:` in `<…>`, `{…}` and Destructuring | settled, rule extended | The ADR states "word + `:`" only for `<…>`. It's needed in `{…}` too, including Reserved Words (`{to: who}`, `{from: src}`), and those keys can then only be read back with `the "to" of m`. A Capture can be named `on:`, but it can never be read. |
| Trailing modifiers | mostly settled | `as` behaves exactly as the ADR says. `ignoring case` goes to the nearest comparison. **`delimited by` is not settled:** in `item 2 of line 3 of r delimited by ";"`, both `item` and `line` are chunks. The prototype attaches it to the outermost chunk in the `of` chain, which is what the sketch meant. `offset of … ignoring case` has no attachment point, now that `offset` is a function. |
| `first`/`last` as Captures vs ordinals | settled | Ordinals only exist after `the` and `replace`. `replace first in s …` (a pattern variable named `first`) vs `replace first <…>` is decided on the next token. |
| Splicing a Pattern value | settled, but it collides with grouping | `( … )` means "expression", so the sketch's `one or more of (letter or digit)` **silently parses as a splice of the boolean `letter or digit`**, and `(ignoring case) "x"` fails. The prototype groups pattern elements with a nested `<…>` and makes `ignoring case` trailing (`"x" ignoring case`). |
| `..` vs `...` | settled | By longest match. `1...3` is an error at `...`. |
| `n bytes`, `bytes` and build `as` | settled | By mode, plus the build rule above. `ihl * 4 bytes` outside `<< >>` is gone (no data-size Unit). |
| Keyword-separated commands | settled, costly | Seven sketch lines needed rewriting (`mail … about … because …`, `log error rest`, `handle key k`, `show results it`, `tell customer r`, `write doc to storage`, `mark paid n`). Each fails at the first word after one complete argument. |
| The word after `ask X to` | settled | `ask http to delete …`, `tell ledger to add …` and `ask mail to send …` all parse. |
| Computed keys and English keys | settled | `the (s) of results` and `the date of the at of top` both parse. But `the f of x` is a key unless `f` is built in, so a user function (`function tax of amount, rate`) called as `the tax of 100` would change meaning with the Script's function list. Recommend `f(x)` only for Script functions. |
| Expression `replace` | settled | `put replace <…> in names with first & " " & last into flipped` |
| `=` in `script variable x = 0` | settled | |
| `say`, and a bare expression at the prompt | `say` settled; the prompt isn't | `say` parses as an ordinary Command Call. For the prompt, see §1. |

## 3. New collisions the sketch turned up

- **`name (x)` vs `name(x)`.** The ADR says `name(args)` is a call, but not whether the space matters. The prototype needs it to: `name(` with no space is a call, and with a space `(` is grouping. Otherwise `say (a + b) & " items"` parses as `say(a + b)` followed by a stray `& " items"`.
- **`where` on a continuation line** (08) is a syntax error under ADR 0019's line rules. The head now sits on one long line.
- **`else` on the line after a single-line `if`** (06) is a syntax error. Allowing it would collide with a `match` branch's `else` inside a `when` body.
- **`return` as the line-break constant** (`& return &`, from HyperTalk) is a Reserved Word used as an operand. It parses by position, but `return return` is a trap. Consider `newline` instead.
- **`send refund to approvals`** parses, but it sends a message *named* `refund` with no argument: the word after `send` is always the message. The reference flavour's `send it to approvals` had the same problem. The sketch now writes `send review with refund to approvals`.
- **Reserved words where the sketch used them as names:** `at: where` (11) and `on:` (08) are now `loc` and `paidOn`.
- **`is empty`** is always the predicate, so a variable named `empty` can't be compared with `is`.
- **`--` starts a comment everywhere,** so `5--3` is `5`. That's standard, but worth one line in the spec.

## 4. First-error positions

`broken.talk` has 29 cases. Run `bun prototypes/parser-sketch/run.ts --broken`. In every case the first token that can't continue is well defined, including the tricky ones:

- **A missing `end repeat`** is reported at the name after `end` (`end t`), not at `end`. `end` is a valid way to continue the block; `t` isn't.
- **`put a << b`** fails at `<<`, and **`1...3`** fails at `...`.
- **`put <"a", bogus>`** fails at `bogus`. That needs the pattern-keyword list, now in `grammar.toml`.

The spec has to fix three things:

1. **Where end of line is.** In `put 5 into   -- note`, the prototype puts the newline token after the comment (col 64). Reporting it at the last code token, or at the comment, is equally well defined, but one of them must be chosen.
2. **Lexer errors.** Unterminated text is reported at the opening quote. The alternative is the end of the line.
3. **Whether "not a Container" is a syntax error** (`put "Z" into character 20 of "short"`, reported at the start of the Container) or a checker diagnostic. It changes which error is first.

Diagnostics also get worse in two places. Neither is a parity problem, but both matter for a beginner surface:

- **Continuation moves errors down a line.** An open bracket or a trailing operator swallows the newline, so `put [1, 2,` reports on the next line. A trailing `and` followed by a `wait …` line even becomes `and wait`.
- **Contextual chunk words give generic messages.** `put item of x into y` reports "expected `into`, found `of`".

## 5. `grammar.toml` (first draft)

[`grammar.toml`](grammar.toml) has 49 Reserved Words, grouped by why each one has to be reserved. Beside them are the contextual words and their positions, the precedence ladder, where each modifier attaches, the built-in properties, the Unit catalogue, the Text Pattern keywords and the Binary Pattern types. The parser reads its word lists from the file, so the draft has been exercised. `--check-table` runs the checks the generator would: no Unit is reserved, no contextual word is reserved, and no Unit shadows `digits`, `bytes`, `times` and so on.

Compared with the ADR's example list:

- **Needed, but not in the ADR's list:** `in`, `wait`, `after`, `the`, `of`, `is`, `not`, `and`, `or`, and every statement keyword (`add`, `subtract`, `multiply`, `divide`, `delete`, `set`, `replace`, `exit`, `pass`, `throw`).
- **Listed by the ADR, not needed to parse valid code, but needed for good errors:** `to`, `into`, `be`, `then` and `where`. With all five made contextual, the 11 sketch files give identical trees. The broken cases get worse, though:
  - `put 1 + into x` reports at `x` instead of `into`.
  - `where` at the start of a continuation line parses silently, as a Command Call to a Handler named `where`.
  - `if x is a then …` reads `then` as a kind.

  So their reservation earns its keep through first-error positions. It costs keys like `{to: …}` (§2) and names like `where` (11).
- **Precedence**, lowest first: `for every` < `or` < `and` < `not` < comparisons (non-associative, `ignoring case` postfix) < `&` < `..` < `+ -` < `* / mod div` < `^` < unary `-` < `as` < `of`/`'s`/call.

## 6. Sketch changes

The sketch files were updated in place on this branch, in the ADR 0019, 0012, 0013 and 0017 spellings. The main changes:

- `and wait` on every suspending Operation.
- `tell log to write` in place of `log …`, and `ask clock to now` in place of `the time from clock`.
- Suffix queueing modifiers.
- `every … for every … sorted by` Comprehensions.
- `put ...xs after ys`, and `put replace … into`.
- Splices written `(year)`.
- `round(x, n)` and `the json of (…)`.
- Build fields written `as uint16`.
- `readFloat`, `fetchB` and `with` removed.

The first error in each original, before the update:

```
02  9:13  `put round third to 2 places`: `round` reads as a variable, then `third` can't continue
03 30:16  `character 20 of "short"` is not a Container
04  5:8   `send it to …`: `it` is reserved
05 29:49  `log error rest`: keyword-shaped arguments
06 43:5   `on every tick … end tick`: the prefix modifier read as the Handler name
07  6:21  `save value as key in storage`: Host-defined syntax
08 10:5   `where` on a continuation line
09 84:13  `round mean to 1 places`
10 30:26  `bytes 0D 0A 1A 0A` as a bytes literal
11 39:17  `json of (…)` without `the`
```

## 7. Proposed narrowing notes for ADR 0019

1. The reserved list must include every statement keyword, plus `in`, `wait`, `after`, `the`, `of`, `is`, `not`, `and` and `or`. `to`, `into`, `be`, `then` and `where` stay reserved for the error positions they give, not for the parse.
2. Chunk words are decided by a FOLLOW set published in `grammar.toml`. A chunk word followed by `-` is always a chunk.
3. "A word followed by `:` is a key" holds in `{…}` and Destructuring too, Reserved Words included.
4. In a Handler head, `, replacing|dropping|queued|deciding`, `, every time` and `, during name` are modifiers.
5. `name(` with no space is a call. A space before `(` makes it grouping.
6. Compound Units are written without spaces, and a spaced `/` is division.
7. `delimited by` attaches to the outermost Chunk Expression of an `of` chain.
8. Text Pattern elements group with a nested `<…>`, since `( … )` is always an expression. `ignoring case` on an element is trailing.
9. Inside a `<< >>` build, `as` followed by an integer type is the field type.
10. `from` in `wait for` takes a postfix-level operand.
11. A kind or Unit after `is a`, `can be` or `as` is never a Reserved Word.
12. First-error positions: define where the end-of-line token is, the position of lexer errors, and whether "not a Container" is a syntax error.
13. Narrows ADR 0014: at the prompt, a leading non-reserved word is a Command Call only if the Session Script has that Handler. Otherwise the Entry is an expression.

Still open, and not decided here: `return` as the line-break constant, whether `offset … ignoring case` gets syntax, and a user-function spelling other than `f(x)`.
