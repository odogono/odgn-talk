# PROTOTYPE: throwaway parser over the syntax sketch (issue #38)

A throwaway TS lexer and recursive-descent/Pratt parser, written to check [ADR 0019](../../docs/adr/0019-one-predictive-grammar-with-contextual-keywords.md) (on `main`) against the [syntax sketch](../syntax-sketch). It parses and prints trees. It doesn't lower, check or run anything. **Read [FINDINGS.md](FINDINGS.md) first.**

Run from the repo root with Bun:

```sh
bun prototypes/parser-sketch/run.ts                  # parse the 11 sketch files, print the lookahead report
bun prototypes/parser-sketch/run.ts --tree           # …and a parse tree per file
bun prototypes/parser-sketch/run.ts --tree prototypes/syntax-sketch/05-text-patterns.talk
bun prototypes/parser-sketch/run.ts --broken         # first-error positions for broken.talk
bun prototypes/parser-sketch/run.ts --check-table    # generator-style checks on grammar.toml
```

| File | What it is |
| --- | --- |
| `grammar.toml` | first draft of the shared table: Reserved Words (with reasons), contextual words, precedence, modifiers, built-in properties, Units, pattern keywords |
| `lexer.ts` | the modal lexer; the parser names the mode for every token |
| `parser.ts` | the predictive parser: no backtracking, `peek(2)` throws, every LL(2) decision is counted |
| `run.ts` | report, tree printer, broken-case runner, table checks |
| `broken.talk` | deliberately broken (and deliberately surprising) lines |
| `FINDINGS.md` | the verdict and everything that fed it |

The sketch files in `../syntax-sketch` were updated to the ADR 0019 spellings on this branch. The `syntax-sketch` branch keeps the originals.
