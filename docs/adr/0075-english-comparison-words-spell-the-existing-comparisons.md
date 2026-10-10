# English comparison words spell the existing comparisons

Comparisons gain the English operator words that AppleScript readers reach for. Each one is another spelling of a comparison the language already has, and lowers to exactly its instructions:

| Written | Means |
| --- | --- |
| `a does not contain b` | `not (a contains b)` |
| `a does not begin with b` | `not (a begins with b)` |
| `a does not end with b` | `not (a ends with b)` |
| `a does not match b` | `not (a matches b)` |
| `a is greater than b`, `a is not greater than b` | `a > b`, `not (a > b)` |
| `a is less than b`, `a is not less than b` | `a < b`, `not (a < b)` |
| `a is at least b`, `a is not at least b` | `a >= b`, `not (a >= b)` |
| `a is at most b`, `a is not at most b` | `a <= b`, `not (a <= b)` |
| `a comes before b` | `a < b` |
| `a comes after b` | `a > b` |

For example:

```
if name does not begin with "_" then say name
if the length of line is greater than 80 then add 1 to long
if total is at least 10 GBP then applyDiscount
if surname comes before "M" ignoring case then put surname after firstHalf
```

We chose this because beginners write the English form first, and without the negated forms they write `if not (s contains "x")`, as the Standard Library itself does three times (`text.talk`, `date.talk`). Comparisons already have words (`is in`, `is not in`, `contains`, `begins with`), so the negated and ordering forms finish a set a reader already half knows. None of them needs a Reserved Word or a third token of lookahead. Each adds at most one second-token decision, and each is surface syntax only: no new instruction, no new Fuel, and no new meaning for `ignoring case`. Settled in #528.

## Considered Options

- **Only the negated forms:** they are the only ones our own sources miss (four `not (… contains …)` and `not (… matches …)` workarounds, and no word form of `<` anywhere). But the ordering words are the ones a reader from AppleScript or spoken English tries first, they cost one decision each, and they can't change the meaning of valid code that doesn't use them, except in the corner cases below.
- **`does not contains`, as a plain `not` between subject and operator:** it reads as broken English.
- **`doesn't contain`:** an apostrophe inside a word would need a lexer change, and `'s` is already an operator.
- **`is not greater than` rejected, so only `is greater than` exists:** every other `is` form (`is in`, `is a`, `is empty`) takes `not`, so a reader would expect this one to as well. It means `not (a > b)`, which gives what `a <= b` gives, and raises `can't compare` for the same operands.
- **`is greater than or equal to`:** five words for `>=`, and `or` would need a three-token decision against the boolean `or`. `is at least` says the same in two.
- **`comes before` as Collation, or only for text and lists:** Collation belongs to the `locale` Capability. `comes before` is `<`, with `<`'s ordering for every kind it orders, so a reader who learns one has learnt the other.
- **`does not come before`, `is not before`:** `a comes after b or a = b` and `not (a comes before b)` already say it, and each would add another decision.
- **A formatter that rewrites one spelling into the other:** the formatter would then decide which spelling a Script's author meant to teach. It keeps the author's tokens, as it does for `is` and `=`.
- **A Lint that prefers one spelling:** neither is wrong, and a Lint that fires on correct, readable code trains readers to ignore Lints.
- **An Advanced tag:** under ADR 0027's test, these are the beginner spellings, not the advanced ones.

## Consequences

- **Syntax:** narrows ADR 0019.
  - `does` and `comes` are contextual keywords in operator position, and join the FOLLOW set. So a chunk index named `does` or `comes` needs brackets: `line (does) of s`.
  - **`does-not`** is a new second-token decision: in operator position, `does` followed by `not` is the operator, and otherwise the word ends the expression. After `does not` comes exactly one of `contain`, `begin with`, `end with` or `match`, and anything else is a syntax error at that token. `contain` and `begin` are contextual there. `end` and `match` are Reserved Words, which is no obstacle, since the position is fixed.
  - **`ordering-words`** is a new second-token decision: after `is` or `is not`, `greater` or `less` followed by `than`, or `at` followed by `least` or `most`, is the operator. Otherwise the word is a Name, so `x is greater` still compares `x` with a variable named `greater`.
  - **`comes`** is a new second-token decision: in operator position, `comes` followed by `before` or `after` is the operator, and otherwise the word ends the expression. `after` is already reserved, and `before` gains this position.
  - Each is at precedence level 4, non-associative, with the other comparisons, and takes a trailing `ignoring case` like the comparison it spells.
  - In a Command Call, `does` and `comes` are never labels when their decision gives the operator.
- **Lines:** narrows ADR 0019. A line that ends with the last word of one of these operators in operator position, `contain`, `match`, `than`, `least` or `most`, continues, as `contains` and the `with` of `begins with` do. A label spelt the same still doesn't. `comes before` and `comes after` don't, because `put x before` and `put x after` must still end at the line break.
- **Source this breaks:** each of these was valid and is now read differently or rejected. None appears in the Conformance Corpus, the Standard Library or the examples.
  - A Command Call with a label `does` whose argument starts with `not` (`check x does not ready`), or a label `comes` whose argument is a Name `before` (`order x comes before`).
  - A Command Call whose argument ends `is greater`, `is less` or `is at`, followed by a label `than`, `least` or `most` (`check x is greater than y`).
  - A chunk index Name `does` or `comes`, as above.
- **Lowering:** narrows ADR 0010. No new instruction. Each form emits the instruction of the comparison it spells, at the operator's first word, followed for `does not` and `is not` by `not` at the same position. So `a does not contain b` emits `contains` `not`, as `not (a contains b)` does, `a is at least b` emits `greater-or-equal`, and `a comes before b` emits `less`. Fuel and errors are the spelled comparison's, positioned at the operator's first word.
- **Tooling:** the formatter keeps both spellings, and no Lint prefers either. The `suggest-ignoring-case` hint covers each word form as it covers the comparison it spells, so `does not match` is left alone as `matches` is. Editor highlighting colours `does` and `comes` as it colours `begins`.
- **Surface:** Beginner Surface, with no `[[advanced]]` tag (ADR 0027).
