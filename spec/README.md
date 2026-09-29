# The odgn-talk Spec

<!-- generated: version -->

This is language **1.0-rc**, with Cost Model **0**.

<!-- end -->

The Spec states every rule of the language once, in its final form. [Chapter 0](00-introduction.md) says how to read it. The [ADRs](../docs/adr/) hold the reasons, and the [tour](../docs/tour.md) is an informative introduction.

## Chapters

0. [Introduction and conventions](00-introduction.md)
1. [Lexical structure](01-lexical-structure.md)
2. [Grammar](02-grammar.md)
3. [Values](03-values.md)
4. [Expressions and statements](04-expressions-and-statements.md)
5. [Handlers, messages and scheduling](05-handlers-messages-and-scheduling.md)
6. [Errors and limits](06-errors-and-limits.md)
7. [Libraries and the Standard Library](07-libraries-and-the-standard-library.md)
8. [The Abstract Machine and the Cost Model](08-the-abstract-machine-and-the-cost-model.md)
9. [Embedding](09-embedding.md), with the interface declarations [`talk.go`](embedding/talk.go) and [`talk.ts`](embedding/talk.ts)
10. [Save and restore](10-save-and-restore.md)
11. [The Trace and conformance](11-the-trace-and-conformance.md), with the display form
12. [Sessions and tooling](12-sessions-and-tooling.md)

## Appendices

- [A. Glossary](appendix-a-glossary.md)
- [B. Implementation order](appendix-b-implementation-order.md)
- [C. Handed off open](appendix-c-handed-off-open.md)

## Data Files

| File | Holds | Shown in |
| --- | --- | --- |
| [`version.toml`](data/version.toml) | The language version | [0](00-introduction.md) |
| [`grammar.ebnf`](data/grammar.ebnf) | The grammar's productions | [2](02-grammar.md) |
| [`grammar.toml`](data/grammar.toml) | Reserved Words, contextual keywords and the FOLLOW set | [2](02-grammar.md) |
| [`unicode.toml`](data/unicode.toml) | The Unicode version and the hash of each UCD file used | [1](01-lexical-structure.md) |
| [`units.toml`](data/units.toml) | The Unit Catalogue | [3](03-values.md) |
| [`errors.toml`](data/errors.toml) | The error-code catalogue | [6](06-errors-and-limits.md) |
| [`limits.toml`](data/limits.toml) | The limits and the default limit profile | [6](06-errors-and-limits.md) |
| [`machine.toml`](data/machine.toml) | The Abstract Machine's instruction set | [8](08-the-abstract-machine-and-the-cost-model.md) |
| [`costs.toml`](data/costs.toml) | The Cost Model | [8](08-the-abstract-machine-and-the-cost-model.md) |
| [`host-errors.toml`](data/host-errors.toml) | The Host error catalogue | [9](09-embedding.md) |

Each has a schema in [`data/schema/`](data/schema/). Run `bun install`, then `bun run spec:gen` after editing a Data File or `CONTEXT.md`.
