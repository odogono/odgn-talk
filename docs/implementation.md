# TS Core value foundation

This is the first focused slice of [#126](https://github.com/odogono/odgn-talk/issues/126), as ordered by [Appendix B](../spec/appendix-b-implementation-order.md). The Spec and Data Files remain the authority. This slice is not a conforming Core: it constructs and encodes values, but does not load or execute Scripts.

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

`bun run build` verifies the pins and builds `dist/index.js`, an ES module usable in a browser without Bun or Node dependencies. To check it in a real browser, run `bun run test:browser` and visit `http://127.0.0.1:3926/`. The smoke test disables platform Unicode functions and checks values, encodings, display forms and deeply nested values. Stop the server when finished. CI checks lint, formatting, regeneration, types, tests, the implemented corpus selection, the browser build and all existing spec/grammar/lowering/corpus-format checks.

## Remaining step 1 work

The lossless lexer/parser, checker and diagnostics, normative lowering and disassembly, executable Abstract Machine, Built-ins and expressions/statements, Cost Model 0 Fuel/allocation, remaining value kinds, Trace sink and Group/Load/Deliver/Request/Pump/Inspect remain to be implemented. The text-model Trace Cases cannot run until those pieces exist. Seed blessing requires the issue's specified procedure and human review; #126 stays open for the subsequent slices.
