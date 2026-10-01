# TS Core foundations

These are the first focused slices of [#126](https://github.com/odogono/odgn-talk/issues/126), as ordered by [Appendix B](../spec/appendix-b-implementation-order.md). The Spec and Data Files remain the authority. The Core constructs and encodes values and parses source losslessly. It does not yet check, load or execute Scripts, so it is not a conforming Core.

## Public values

Under Bun, import from the package:

```ts
import { text, num, list, map, encodeValue, readDisplay } from "@odgn/northtalk";

const title = text("e\u0301"); // NFC: é
const values = map([["title", title], ["count", num(1)]]);
console.log(values.toString()); // {title: "é", count: 1}
console.log(encodeValue(values)); // {"title":"é","count":1}
console.log(readDisplay(values.toString()).equals(values)); // true
```

The implemented portion of [the embedding declarations](../spec/embedding/talk.ts) is `HostError`, `Value`, `Decimal`, `nothing`, `bool`, `text`, `num`, `dec`, `list`, `map`, `record`, `encodeValue` and `decodeValue`, plus `readDisplay`, the display reader required by chapter 11. Implemented kinds are Nothing, booleans, numbers, text, lists and maps. `Value` supports the accessors for those kinds, structural `equals` and display-form `toString`. Construction is opaque; invalid inputs throw `HostError` with code `invalid value`. `decodeValue` retains the resolver parameter for later Host Object support. Unsupported kinds and tags are refused explicitly.

Text is checked for lone surrogates and normalized to NFC at construction. Lists and maps snapshot their input; map keys are normalized, checked for duplicates and kept in insertion order. `record` refuses JS array-index keys; use `map` to specify their order. Number constructors retain trailing zeros, expand a float's shortest round-trip digits and refuse values requiring rounding or exceeding the spec's limits. `Decimal` supports canonical text, exact integer reads and lossy float reads. Arithmetic follows in a later slice.

`src/unicode.ts` and `src/text.ts` provide internal foundations for Character segmentation, simple folding, default full case mapping (including final sigma), scalar ordering, NFC joins, whole-Character literal searches, and character/code-point/word/line/item splitting. They are not additions to the public embedding interface. They charge no Fuel outside a Run; the Abstract Machine must charge Cost Model 0 when it calls them. This slice adds no language-level execution or resource-accounting claims.

## Lossless source parsing

```ts
import { parseSource, syntaxText } from "@odgn/northtalk";

const result = parseSource('on greet\n  say "hi" -- greeting\nend greet');
if (result.error) {
  const { code, tok } = result.error;
  console.log(`${code} at ${tok.line}:${tok.col}`);
} else {
  console.log(syntaxText(result.tree)); // exactly the original source
}
```

`parseSource` accepts a complete Script or Library and returns either a typed concrete syntax tree or its first `ParseError`. Invalid scalar source throws `HostError("invalid value")` before parsing. The syntax tree is a Core front-end API; it is not an addition to the normative embedding declarations. Syntax checking here implements chapters 1 and 2; load-time checker diagnostics from `diagnostics.toml` follow in a later slice.

Each `SyntaxNode` identifies a recognition production with `rule`, ordered `children`, and half-open `start`/`end` spans. Its children are further nodes or `Token`s. A token retains its exact `raw` spelling, `pos`/`end`, initial lexical `mode`, and `leadingTrivia`. Trivia records preserve the initial BOM, spaces/tabs, comments and continued physical line breaks; statement-ending line breaks and EOF are tokens. Spans include leading trivia, and every source character belongs to exactly one token or trivia record. `syntaxText` reconstructs source by walking the tree, without requiring a separate source string. Offsets index the original TS string in UTF-16 code units; diagnostic `line` and `col` are 1-based Unicode scalar positions, with tabs counting as one column. Text literal content remains as written; the existing text value constructor performs pinned NFC when a literal becomes a value.

The low-level `Lexer` is also exported. Call `lex(offset, mode)` at a token boundary; it returns the next physical token without applying statement continuation. `where(offset)` provides scalar positions. Modes are `operand`, `operator`, `pattern`, `unit` (after a number), and `type` (after `as`). The parser fixes each token's interpretation on its first scan, buffers at most two tokens and never backtracks or relexes. Productions run through an explicit work stack, so deeply nested source does not depend on the JavaScript call stack. Scalar column lookup uses indexes rather than rescanning long lines. It handles the full grammar, including contextual keywords, compound units, Text/Binary Patterns and block Lambdas inside brackets. No platform Unicode normalization or Host imports are used by the front end.

```sh
bun run syntax:generate
bun run syntax:check
bun test tests/lexer.test.ts tests/parser.test.ts tests/syntax-fixtures.test.ts
```

The generator copies the syntax lists from `grammar.toml` and Unit spellings from `units.toml` into browser-safe TS tables. The check reproduces those tables byte for byte and runs in CI, tests and builds. Core tests independently exercise authored first-error fixtures, every corpus Script, Standard Library, syntax sketch and `talk` documentation example. They also check every token/trivia span and exact source reconstruction. These parser checks do not establish execution, lowering or Trace conformance.

## Generated Unicode tables

```sh
bun install --frozen-lockfile
bun run unicode:generate
bun run unicode:check
```

The generator downloads all ten files pinned by [`unicode.toml`](../spec/data/unicode.toml) into `.cache/unicode/18.0.0/` when absent. Every invocation checks every file's SHA-256; corrupt cached data fails rather than being silently replaced. Delete the offending cache file to download it again. `unicode:check` also reproduces the generated tables byte for byte and fails if the committed TS is stale. A fresh build therefore needs network access once, and subsequent builds can use the verified cache offline.

The committed `src/generated/unicode.ts` includes the source hashes. Runtime code imports only TS tables and uses no platform normalization, `Intl.Segmenter`, Unicode regular-expression properties or platform case mapping. Hangul normalization is algorithmic. Extended grapheme boundaries follow Unicode 18's UAX #29 revision 49, including its changed GB9c rule. The [Unicode license](../src/generated/UNICODE-LICENSE.txt) accompanies the tables and is copied into `dist/` with the browser bundle.

## Verification and corpus selection

```sh
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run corpus:run
bun run corpus:run --list
bun run corpus:run text-model/host-text-normalised-to-nfc
bun run build
```

`bun run lint:fix` applies ESLint fixes using `@nkzw/eslint-config`; `bun run format` formats the TypeScript sources and ESLint configuration with Prettier. CI requires both lint and formatting checks to pass. Generated Unicode tables and normative files under `spec/` are excluded: their existing regeneration and Spec checks verify them instead.

Record notable implementation changes under the appropriate Added, Changed, Deprecated, Removed, Fixed or Security heading in [CHANGELOG.md](../CHANGELOG.md)'s Unreleased section. At release, move those entries into a dated version section and add its comparison link. Implementation releases are separate from Language and Cost Model versions.

Tests cover every row and all five NFC columns of the pinned NormalizationTest, identity normalization for every unlisted scalar, every GraphemeBreakTest row, every C/S folding mapping, UnicodeData and unconditional SpecialCasing mappings, final-sigma contexts, text searches/chunks, constructor refusal paths, immutable containers, insertion order, display/encoding round trips and deep values without a reader-only nesting limit.

The execution runner is separate from `corpus:check`, the existing format checker. Its default selection is the implemented seed case `text-model/host-text-normalised-to-nfc`, which runs all five encoding lines through public Host constructors and `encodeValue`. Paths are relative to `corpus/`, or absolute. `--list` marks every existing case supported or deferred. Explicitly selecting deferred case kinds fails; nothing is silently skipped. A mismatch identifies the case, source line, first differing UTF-8 byte, and expected/actual encodings. No blessing or seed rewriting is provided by this slice.

`bun run build` verifies the pins and builds `dist/index.js`, an ES module usable in a browser without Bun or Node dependencies. To check it in a real browser, run `bun run test:browser` and visit `http://127.0.0.1:3926/`. The smoke test disables platform Unicode functions and checks values, encodings, display forms, deeply nested values, lossless parsing and syntax diagnostics. Stop the server when finished. CI checks lint, formatting, regeneration, types, tests, the implemented corpus selection, the browser build and all existing spec/grammar/lowering/corpus-format checks.

## Remaining step 1 work

The checker and load diagnostics, normative lowering and disassembly, executable Abstract Machine, Built-ins and expressions/statements, Cost Model 0 Fuel/allocation, remaining value kinds, Trace sink and Group/Load/Deliver/Request/Pump/Inspect remain to be implemented. The text-model Trace Cases cannot run until those pieces exist. Seed blessing requires the issue's specified procedure and human review; #126 stays open for the subsequent slices.
