# TS Core foundations

These are the first focused slices of [#126](https://github.com/odogono/odgn-talk/issues/126), as ordered by [Appendix B](../spec/appendix-b-implementation-order.md). The Spec and Data Files remain the authority. The Core constructs and encodes values, parses source losslessly and checks names and bindings. It does not yet perform every load check, load or execute Scripts, so it is not a conforming Core.

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

`parseSource` accepts a complete Script or Library and returns either a typed concrete syntax tree or its first `ParseError`. Invalid scalar source throws `HostError("invalid value")` before parsing. The syntax tree is a Core front-end API; it is not an addition to the normative embedding declarations. Syntax checking here implements chapters 1 and 2; name and binding checks are described below.

Each `SyntaxNode` identifies a recognition production with `rule`, ordered `children`, and half-open `start`/`end` spans. Its children are further nodes or `Token`s. A token retains its exact `raw` spelling, `pos`/`end`, initial lexical `mode`, and `leadingTrivia`. Trivia records preserve the initial BOM, spaces/tabs, comments and continued physical line breaks; statement-ending line breaks and EOF are tokens. Spans include leading trivia, and every source character belongs to exactly one token or trivia record. `syntaxText` reconstructs source by walking the tree, without requiring a separate source string. Offsets index the original TS string in UTF-16 code units; diagnostic `line` and `col` are 1-based Unicode scalar positions, with tabs counting as one column. Text literal content remains as written; the existing text value constructor performs pinned NFC when a literal becomes a value.

The low-level `Lexer` is also exported. Call `lex(offset, mode)` at a token boundary; it returns the next physical token without applying statement continuation. `where(offset)` provides scalar positions. Modes are `operand`, `operator`, `pattern`, `unit` (after a number), and `type` (after `as`). The parser fixes each token's interpretation on its first scan, buffers at most two tokens and never backtracks or relexes. Productions run through an explicit work stack, so deeply nested source does not depend on the JavaScript call stack. Scalar column lookup uses indexes rather than rescanning long lines. It handles the full grammar, including contextual keywords, compound units, Text/Binary Patterns and block Lambdas inside brackets. No platform Unicode normalization or Host imports are used by the front end.

```sh
bun run syntax:generate
bun run syntax:check
bun test tests/lexer.test.ts tests/parser.test.ts tests/syntax-fixtures.test.ts
```

The generator copies the syntax lists from `grammar.toml` and Unit spellings from `units.toml` into browser-safe TS tables. The check reproduces those tables byte for byte and runs in CI, tests and builds. Core tests independently exercise authored first-error fixtures, every corpus Script, Standard Library, syntax sketch and `talk` documentation example. They also check every token/trivia span and exact source reconstruction. These parser checks do not establish execution, lowering or Trace conformance.

## Semantic names and bindings

```ts
import { checkSource, checkSyntax, parseSource } from "@odgn/northtalk";

const result = checkSource('on greet\n return later\n put 1 into later\nend greet');
console.log(result.ok); // true: later starts as Nothing
console.log(result.tree?.scopes); // unit and body bindings, including it

const invalid = checkSource('on greet\n return absent\nend greet');
console.log(invalid.diagnostics); // unknown name at line 2, column 9

const parsed = parseSource('constant answer = 42');
if (!parsed.error) checkSyntax(parsed.tree); // check an existing lossless tree
```

`checkSource` parses once and returns either the first syntax error, with no semantic tree or load diagnostics, or the semantic tree and ordered diagnostics. `checkSyntax` accepts an existing `SyntaxNode` without reconstructing or reparsing source. Both are front-end APIs, not additions to the embedding interface. `ok` means the implemented semantic checks succeeded; later load checks and compilation are still required.

The typed semantic tree retains grammar productions and operator/literal tokens for later lowering, omits trivia and empty productions, and replaces declaration, binding and reference tokens with `SemanticName` nodes. Every node has a half-open UTF-16 source span and a 1-based scalar start position. Name nodes identify their role and resolved `Binding`; body nodes identify their scope. Scopes expose parameters, locals (including `it`), and Lambda captures in first-use order. Local bindings record their Nothing initialization. The input lossless tree remains unchanged. Conversion and traversal use explicit work stacks, including for deeply nested expressions.

The checker collects unit declarations, parameters, destructuring/Capture bindings and Container roots before resolving value references and calls. Locals cover the whole body; branches, loops, `catch` and event branches add no scopes. Lambda scopes capture enclosing locals, including those needed by nested Lambdas; Script Variables remain live unit bindings. Built-ins may be shadowed, Script/Library function names are values, and Handler/Built-in function names require a call. Command Calls resolve local/imported Handlers or continue along the Message Path. Message, property, map-key, kind, Grant and Operation positions do not undergo value-name lookup. Binary Pattern bare sizes require a completed earlier field binding, while pins resolve body names.

Implemented diagnostics are `unknown name`, `not a value`, `name clash`, `duplicate name`, direct `unknown import` checks, `can't write`, `not a property`, `wrong argument count`, `default order`, `not constant`, `outside a loop`, `leaves finally`, `not in a lambda`, `wrong message` and `bad suffixes`. Duplicate checks cover parameter lists, destructuring and Text Pattern Captures; rebinding a local in a separate pattern is valid. Diagnostics use the token positions and tie ordering from `diagnostics.toml`, with one diagnostic of a code per offending token. Import clashes point to the local name in the `use` line, including a rename. The browser-safe tables include diagnostic order, Built-ins and Standard Library export kinds and function contracts, generated from the Spec Data Files.

Every Container write rejects a Constant root or a captured Lambda local at the root's name. Imported Constants keep their binding when written, including through a rename. Script Variables and the Lambda's own locals remain writable; writing a Built-in Constant's name creates a local that shadows it. `set` on a bare variable reports `not a property` at `set`; property paths still need later Host Object kind checks.

Named calls use the resolved binding's `contract: { required, total }` to check argument counts, including forward and recursive calls, Built-ins and imported Standard Library functions. Function Values held in variables and Handler calls retain their run-time argument checks. Required parameters after a default report `default order`. Constant/Script Variable initializers and parameter defaults permit literals, earlier Constants (including imports) and Built-ins, and report `not constant` at the first forbidden reference or construct. Self and forward Constant references, Script Variables, parameters, user functions, `me`, `it` and `the target` are forbidden when evaluated by an initializer/default. Lambda literals defer their bodies; creating one is permitted if it captures no enclosing locals or parameters. Initializers and defaults are not evaluated by this pass.

A control pass walks the semantic tree after binding checks. Each Handler, function and Lambda body starts with no enclosing loop, `finally` block or Lambda context, so a Lambda's `return` and loops are its own. `exit repeat` and `next repeat` report `outside a loop` with no loop in their body, and `leaves finally` when their innermost loop is outside the innermost `finally` block (of a `try` or a Handler) that contains them. `return`, `veto` and `pass` inside a `finally` block report `leaves finally`. `pass` and bare `the target` inside any Lambda report `not in a lambda` at `pass` or `the`, including Lambdas in initializers and defaults; `the target of x` is a key. Outside Lambdas, `pass m` in a Handler reports `wrong message` at `m` unless `m` is the clause's message, compared case-sensitively. A Handler head reports `bad suffixes` once, at the first suffix that repeats one, adds a second of `queued`/`dropping`/`replacing`, pairs `queued` with `deciding`, or is `during` on a Handler other than `on error`. Join, decision and Library-only placement rules remain for later slices.

Pass `{ objects: ['button'], libraries: { helpers: { double: { kind: 'function', contract: { required: 1, total: 1 } } } } }` to either checker to supply well-known Host Object names and registered Library exports. Kind-only entries (`function`, `handler` or `constant`) remain accepted and defer function argument-count checks until the Library loader supplies a contract. Standard Library metadata is known by default; a supplied entry overrides one Library's exports. Library graph/cycle checks, Grants, constant/default evaluation, Host Object read-only properties, kinds, effects, Suspension Point, Join and decision diagnostics remain for subsequent slices. No load or execution success is implied.

```sh
bun test tests/checker.test.ts
```

Core tests check exact authored codes, scalar positions, diagnostic ordering, bindings and capture identities, all binding forms, function contracts, initializer/default references, control flow across nested Lambdas, loops and `finally` blocks, Handler suffixes, and deep input. The browser smoke test also exercises name resolution, binding/function contracts and control-flow checks with platform Unicode functions disabled.

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

The remaining checker diagnostics, normative lowering and disassembly, executable Abstract Machine, Built-ins and expressions/statements, Cost Model 0 Fuel/allocation, remaining value kinds, Trace sink and Group/Load/Deliver/Request/Pump/Inspect remain to be implemented. The text-model Trace Cases cannot run until those pieces exist. Seed blessing requires the issue's specified procedure and human review; #126 stays open for the subsequent slices.
