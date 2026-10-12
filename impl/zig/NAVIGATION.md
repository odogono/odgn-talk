# Zig task navigation

Start with the row for your task, then read the linked rules and tests. Read the
[implementation guide](README.md) for build details, and the
[decisions on #625](https://github.com/odogono/odgn-talk/issues/625#issuecomment-6111271797)
before changing anything they settle. For domain terms, use
[GLOSSARY.md](../../GLOSSARY.md); for rationale, use the
[ADR index](../../docs/adr/README.md).

Commands below run from the repository root; Zig commands change to `impl/zig/` first. On a fresh worktree, run
`bun install --frozen-lockfile` and `bun run unicode:check` first; the Unicode
check prepares and verifies the pinned test data. Read the Go and TS Cores for
nothing but the cases they blessed: the Zig Core is written from the Spec.

| Task | Implementation | Rules | Tests and cases | First check |
| --- | --- | --- | --- | --- |
| UTF-8 and Host text | [UTF-8](src/unicode/utf8.zig), [C API](src/talk.zig), [`talk.h`](include/talk.h) | [source text](../../spec/01-lexical-structure.md#source-text), [Text](../../spec/03-values.md#text) | [C Host tests](tests/talk_h_test.c), tests in each file | `cd impl/zig && zig build test` |
| NFC | [normalisation](src/unicode/normalize.zig) | [Unicode](../../spec/01-lexical-structure.md#unicode), [Text](../../spec/03-values.md#text) | [conformance tests](src/unicode/conformance_test.zig) | `cd impl/zig && zig build test` |
| Characters | [grapheme clusters](src/unicode/grapheme.zig) | [Text](../../spec/03-values.md#text) | [conformance tests](src/unicode/conformance_test.zig) | `cd impl/zig && zig build test` |
| Case folding, `word` and `word break` | [folding](src/unicode/case.zig), [words](src/unicode/words.zig) | [Text](../../spec/03-values.md#text), [chunk kinds](../../spec/04-expressions-and-statements.md#chunk-kinds) | [conformance tests](src/unicode/conformance_test.zig), tests in each file | `cd impl/zig && zig build test` |
| The `std` Unicode policy | [policy test](src/unicode/policy_test.zig) | [decisions on #625](https://github.com/odogono/odgn-talk/issues/625#issuecomment-6111271797) | the same | `cd impl/zig && zig build test` |
| Decimal input, conversion and arithmetic | [decimal](src/decimal/decimal.zig) | [numbers](../../spec/03-values.md#numbers), [Host values](../../spec/09-embedding.md#values-at-the-boundary) | tests in the module, [C Host tests](tests/talk_h_test.c) | `cd impl/zig && zig build test` |
| Values, equality and copy-on-write | [values](src/value.zig), [Units](src/units.zig), [dates](src/dates.zig) | [values](../../spec/03-values.md) | tests in the modules | `cd impl/zig && zig build test` |
| Display and Value Encoding | [display](src/display.zig), [encoding](src/encoding.zig), [Pattern source](src/pattern.zig) | [display](../../spec/11-the-trace-and-conformance.md#the-display-form), [Value Encoding](../../spec/09-embedding.md#json-and-the-value-encoding) | module tests, [passing cases](corpus-passing.txt) | `cd impl/zig && zig build corpus -- --check-passing` |
| Lexing: tokens, modes, Units and fenced text | [lexer](src/syntax/lexer.zig) | [chapter 1](../../spec/01-lexical-structure.md), [syntax errors](../../spec/02-grammar.md#syntax-errors) | tests in the module | `cd impl/zig && zig build test` |
| Parsing and the syntax tree | [parser](src/syntax/parser.zig), [tree](src/syntax/ast.zig) | [chapter 2](../../spec/02-grammar.md), [`grammar.ebnf`](../../spec/data/grammar.ebnf), [`grammar.toml`](../../spec/data/grammar.toml) | module tests, [broken sources](../../tools/grammar/broken.talk), every corpus `.talk` file | `cd impl/zig && zig build test` |
| Load-time diagnostics and name resolution | [checker](src/check/check.zig) | [load-time diagnostics](../../spec/02-grammar.md#load-time-diagnostics), [resolving a name](../../spec/04-expressions-and-statements.md#resolving-a-name), [Suspension Points](../../spec/05-handlers-messages-and-scheduling.md#suspension-points), [`diagnostics.toml`](../../spec/data/diagnostics.toml) | module tests, every corpus unit's expected `diag` lines | `cd impl/zig && zig build test` |
| Lowering, code units and the canonical disassembly | [lowering](src/lower/lower.zig) | [the lowering](../../spec/08-the-abstract-machine-and-the-cost-model.md#the-lowering), [the source map](../../spec/08-the-abstract-machine-and-the-cost-model.md#the-source-map), [`machine.toml`](../../spec/data/machine.toml) | module tests, [Disassembly Cases](src/corpus/disassembly.zig), [passing cases](corpus-passing.txt) | `cd impl/zig && zig build corpus -- disassembly` |
| Case setup: units, Grants and objects | [case setup](src/corpus/case.zig) | [`case.toml`](../../spec/11-the-trace-and-conformance.md#casetoml) | tests in the module, every corpus `case.toml` | `cd impl/zig && zig build test` |
| Running code: Groups, Pumps, the run loop, errors and unwinding, and charging | [machine](src/machine/machine.zig), [chunks and properties](src/machine/chunks.zig), [Bytes builds and Binary Patterns](src/machine/binary.zig), [conversions](src/machine/convert.zig), [Text Patterns and the matcher](src/machine/matcher.zig), [Cost Model](src/machine/costs.zig), [Built-ins](src/machine/builtins.zig), [exports](src/talk.zig) | [the machine](../../spec/08-the-abstract-machine-and-the-cost-model.md#the-machines-state), [the Cost Model](../../spec/08-the-abstract-machine-and-the-cost-model.md#the-cost-model), [chunks](../../spec/04-expressions-and-statements.md#chunk-expressions), [the Trace](../../spec/11-the-trace-and-conformance.md#the-trace) | [replay](src/corpus/replay.zig), [talk.h replay](src/corpus/talk_replay.zig), [C Host tests](tests/talk_h_test.c), [passing cases](corpus-passing.txt) | `cd impl/zig && zig build corpus -- text-model` |
| Corpus discovery, Trace parsing and backend seam | [runner](src/corpus/main.zig), [Trace parser](src/corpus/trace.zig) | [conformance](../../spec/11-the-trace-and-conformance.md), [record catalogue](../../spec/data/corpus.toml), [grammar](../../spec/data/trace.ebnf) | module tests, [passing cases](corpus-passing.txt) | `cd impl/zig && zig build corpus -- --list` |
| Generated tables | [catalogue emitter](../../tools/zig/generate.ts), [Unicode emitter](../../tools/unicode/generate-zig.ts) → [tables](src/generated/) | [Data Files](../../spec/README.md#data-files) | [emitter tests](../../tools/zig/generate.test.ts) | `bun run zig:check && bun run unicode:check` |
| The C API | [`talk.h`](include/talk.h), [exports](src/talk.zig) | [embedding](../../spec/09-embedding.md), [`talk.go`](../../spec/embedding/talk.go) | [API check](../../tools/zig/api.ts) and [its tests](../../tools/zig/api.test.ts), [C Host tests](tests/talk_h_test.c) | `bun tools/zig/api.ts` |
| Build, targets and CI | [`build.zig`](build.zig), [`build.zig.zon`](build.zig.zon), [workflow](../../.github/workflows/zig.yml) | [ADR 0078](../../docs/adr/0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md) | the workflow's steps | `cd impl/zig && zig build -Dtarget=wasm32-wasi` |

Update generated files through their generators. A Zig upgrade is its own PR
and changes no behaviour.
