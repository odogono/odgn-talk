# Grammar check

A predictive parser that follows [Spec chapters 1 and 2](../../spec/02-grammar.md), kept to check that the grammar stays parseable with two tokens of lookahead and no backtracking, as the #38 parser prototype did. It reads its word lists from [`grammar.toml`](../../spec/data/grammar.toml) and [`units.toml`](../../spec/data/units.toml). It isn't normative, and it isn't a Core: it builds a tree, and doesn't check, lower or run anything (ADR 0028).

```sh
bun run grammar:check                                  # what CI runs
bun tools/grammar/check.ts --report                    # also list the two-token decisions, by count
bun tools/grammar/check.ts --tree tools/grammar/sketch/05-text-patterns.talk
```

| File | What it is |
| --- | --- |
| `lexer.ts` | the modal lexer; the parser names the mode of every token |
| `parser.ts` | the parser: no mark or reset, `peek(2)` throws, and every decision that reads the second token names a `[[decision]]` in `grammar.toml` |
| `check.ts` | parses everything below and fails on a syntax error, a relex, a third token of lookahead, a wrong first error in `broken.talk`, or a listed decision nothing takes |
| `sketch/` | the syntax sketch from `prototype/joins-sketch`, updated to the Spec's spellings |
| `broken.talk` | deliberately broken sources, each with the first error it must give |

The check also parses every `talk` code block in `docs/` and `spec/`, and every `.talk` file in `corpus/`. A block that doesn't start with a declaration is parsed as a Handler body. An example that must fail goes in a plain code block.

The sketch files keep their design-time comments. `-- ALT:` lines are spellings that were considered, and `-- ??` lines are questions from the time, many of them since settled by ADRs.
