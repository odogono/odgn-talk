# Zig task navigation

Start with the row for your task, then read the linked rules and tests. Read the
[implementation guide](README.md) for build details, and the
[decisions on #625](https://github.com/odogono/odgn-talk/issues/625#issuecomment-6111271797)
before changing anything they settle. For domain terms, use
[CONTEXT.md](../../CONTEXT.md); for rationale, use the
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
| Corpus discovery, Trace parsing and backend seam | [runner](src/corpus/main.zig), [Trace parser](src/corpus/trace.zig) | [conformance](../../spec/11-the-trace-and-conformance.md), [record catalogue](../../spec/data/corpus.toml), [grammar](../../spec/data/trace.ebnf) | module tests, [passing cases](corpus-passing.txt) | `cd impl/zig && zig build corpus -- --list` |
| Generated tables | [catalogue emitter](../../tools/zig/generate.ts), [Unicode emitter](../../tools/unicode/generate-zig.ts) → [tables](src/generated/) | [Data Files](../../spec/README.md#data-files) | [emitter tests](../../tools/zig/generate.test.ts) | `bun run zig:check && bun run unicode:check` |
| The C API | [`talk.h`](include/talk.h), [exports](src/talk.zig) | [embedding](../../spec/09-embedding.md), [`talk.go`](../../spec/embedding/talk.go) | [API check](../../tools/zig/api.ts) and [its tests](../../tools/zig/api.test.ts), [C Host tests](tests/talk_h_test.c) | `bun tools/zig/api.ts` |
| Build, targets and CI | [`build.zig`](build.zig), [`build.zig.zon`](build.zig.zon), [workflow](../../.github/workflows/zig.yml) | [ADR 0078](../../docs/adr/0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md) | the workflow's steps | `cd impl/zig && zig build -Dtarget=wasm32-wasi` |

Update generated files through their generators. A Zig upgrade is its own PR
and changes no behaviour.
