# Go Core

The Go Core is module `github.com/odogono/odgn-talk/impl/go`, with public root
package `northtalk`. It supplies immutable values and their Host constructors
and accessors, decimal arithmetic, the display form and its reader, plain JSON
and the Value Encoding. Its internal front end lexes UTF-8 source, parses a
lossless tree, resolves names and bindings, and lowers checked units into the
Abstract Machine's instructions, source maps, Unwind Tables and Event Tables.
It also supplies pinned Unicode text primitives: NFC, extended grapheme cluster
(Character) boundaries, simple case folding, and White_Space-based words and
word breaks. Public loading and execution arrive in the later steps; no
unimplemented public declaration is stubbed. The Spec and Data Files are the
authority; the TS Core is not a
reference ([ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

## Layout

- The root package owns the [embedding interface](../../spec/embedding/talk.go).
  `value.go` and `encoding.go` implement the value and codec declarations.
  `text.go` holds `Text`'s uncharged, UTF-8-validating NFC seam.
  No unimplemented public declaration is stubbed.
- `internal/unicode/` holds the text primitives. Its spans and boundaries use
  zero-based UTF-8 byte offsets; Script positions count Unicode scalars, starting
  at line and column 1. It segments text as given, without normalizing the
  entire source.
- `internal/generated/` holds checked-in tables written from the Spec Data
  Files and pinned Unicode sources, with `UNICODE-LICENSE.txt` beside them.
- `internal/apicheck/` checks root exports and their declarations against
  `talk.go`, allowing private named fields for opaque types. Anonymous
  embeddings are compared even when private, because they can promote public
  members. Unimplemented
  Spec names are reported without failing until #141.
- `internal/syntax/` owns modal lexing and the predictive parser. Tokens retain
  every source byte, including trivia and the initial BOM; `Tree.Source()`
  reconstructs it. Identifiers follow chapter 1's ASCII rules, source is not
  normalized, and only Text literal values are NFC.
- `internal/check/` resolves declarations, body slots, lexical captures and
  initializer dependencies. `Check` returns diagnostics in source order,
  breaking ties by catalogue order. Its options supply well-known object names,
  import signatures and `PatternSize`.
- `internal/lower/` accepts a diagnostic-free checked unit. `Compile` returns
  canonical disassembly and a Go-private varint byte encoding of each body's
  instruction stream. Labels and source maps use instruction indices, never
  byte offsets. Compiling again preserves the checked unit's slots.
- `internal/decimal/` implements exact-input decimals, half-even arithmetic,
  integer and fractional powers, and exact Host conversions. Large powers use
  outward-rounded intervals and increase precision until both bounds select
  the same decimal; exact rational roots handle halfway results.
- `internal/value/` holds the value model, catalogue-based Units, comparison,
  display reader/writer and strict JSON codecs. Containers copy input slices;
  the public accessors return copies. Quantity comparison keeps Base Unit
  magnitudes beyond the number limit internally, so comparison stays total.
- `internal/corpus/` reads case setups and Trace records from generated
  `corpus.toml` tables, runs encoding cases and checks the passing list.
  Its `Backend` interface accepts future Trace production without depending
  on the machine or a particular Trace writer.
- `internal/machine/` and `trace/` reserve the remaining implementation
  boundaries agreed on [#132](https://github.com/odogono/odgn-talk/issues/132).

The module has no third-party requirements and no `go.work`. The REPL, Session
Host and Message Layer driver belong to later work under `cmd/northtalk/`,
`session/` and `driver/` ([ADR 0046](../../docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md)).

## Build and test

Use Go 1.27 and Bun 1.4.2. From the repository root:

```sh
bun install --frozen-lockfile
bun run unicode:check     # verifies/downloads the pinned test sources
cd impl/go
go build ./...
go vet ./...
go test -race -v ./...
gofmt -l .               # must print no paths
```

The Unicode tests read `.cache/unicode/18.0.0/` at the repository root and verify
each source's SHA-256. A missing or corrupt file fails the tests. They cover all
five columns of `NormalizationTest.txt`, scalars absent from its first column,
every `GraphemeBreakTest.txt` row, and simple C/S folding against
`CaseFolding.txt`. The import-policy test refuses platform Unicode tables,
`strings` case functions (including aliases) and `golang.org/x/text`.

## Regeneration

Run from the repository root:

```sh
bun run go:generate       # Core catalogues, corpus formats, grammar and Built-in metadata
bun run unicode:generate # both Cores' Unicode tables and licenses
bun run syntax:generate  # TS syntax tables and the Go Data File tables
bun run check            # checks every generated output against its sources
```

The Go emitter in `tools/go/` reads only `spec/data/`; it imports no TS Core
code. The Unicode generator parses the pinned UCD once for both output formats.
The emitters use `gofmt`, so Go must also be installed for generator commands.
Each generator's `--check` refuses missing or stale Go output without rewriting
it. `bun run go:check` checks the non-Unicode Go tables independently.

## Front-end and lowering checks

Go tests reconstruct every grammar sketch, Corpus source and stdlib Library,
and pin all first errors in `tools/grammar/broken.talk`. The seven units in the six
Disassembly Cases match byte for byte: pools, slots, instruction order and
positions, Unwind Tables and Event Tables. Together they emit every opcode in
`machine.toml`. All seven stdlib Libraries also check, lower and round-trip the
Go encoding. Other tests cover lexical scalar positions, NFC text, nested
captures, binding order, binary-size pins, pattern limits, canonical value
printing and nested cleanup paths.

The 30 new [load-diagnostic Trace Cases](../../corpus/load-diagnostics/)
were blessed by the TS Core. Each still needs the human review required by
[#132](https://github.com/odogono/odgn-talk/issues/132). The Go tests compare
all static diagnostic records with those cases. `initialiser failed` enters
through `Unit.InitialiserFailed`: the loader reports the raising instruction's
source-map position. Its boundary test executes the fixture's lowered numeric
instructions and checks that record; general initialization execution belongs
to the Abstract Machine in [#251](https://github.com/odogono/odgn-talk/issues/251).
The runner from [#249](https://github.com/odogono/odgn-talk/issues/249) now
reads their setups and records. The front-end cases continue to run through Go
tests until disassembly and load-diagnostic backends are connected to its
`Backend` interface; then register them on its passing list.

The checker supports the step 1 diagnostic families represented in that
directory. Within families spanning later facilities, `wrong argument count`
checks local/imported function signatures and `say`; `needless and wait` checks
`say`; `can't suspend here` checks direct suspension; `unknown import` checks
supplied import signatures; and `can't write` checks Constants and captured
locals. Handler call graphs, Library linking and Host Object property Shapes
are completed with the corresponding facilities in step 3. Capability
Operations are lowered, while validating their Grants, modes and argument
Shapes belongs to that step.

As #250 permits, the following complete diagnostic families are deferred to
step 3: `wrong argument`, `unknown operation`, `wrong mode`, `missing and wait`,
`import cycle`, `missing grant`, `not in a library`, `veto outside a decision`,
`after a suspension`, `wrong message`, and `bad suffixes`. These dependencies
are tracked by [#134](https://github.com/odogono/odgn-talk/issues/134), rather
than implemented as public stubs here. The Built-in catalogue contains only
name/call metadata needed for resolution and lowering; its implementations and
the rest of the stdlib catalogue belong to the later runtime work.

## Values and codecs

`Dec` reads the Spec's number syntax without rounding. `FromFloat` uses Go's
shortest round-trip digits. `Decimal.String` keeps trailing zeros; integer
accessors refuse fractions and overflow, and `Float64Lossy` rounds to nearest,
ties to even. Constructors reject invalid input as `HostError{Code: InvalidValue}`.
`InstantFromTime` drops the zone and monotonic reading; because its declared
signature has no error result, a time outside years 0001–9999 panics with that
HostError. Use `Instant` when input needs a returned refusal.

`Value.String` is chapter 11's display form, including text joins for hidden
code points and insertion-order maps. `EncodeValue` preserves every supported
kind and numeric exponent. `DecodeValue` rejects malformed UTF-8, lone
surrogates, duplicate NFC keys and noncanonical Base64, re-parses pattern
sources, and resolves object tags through the supplied resolver. Plain JSON
uses chapter 7's mapping and refuses non-JSON kinds with `ScriptError` code
`not encodable`, carrying `kind` and the first depth-first `path`.

Text Pattern metadata is available for display/encoding; matching arrives with
execution. Function Values and Host Objects have display/equality metadata and
accessors, but there are no Host constructors for them here. Function Values
are refused by storage encoding. Object registration and Group ownership arrive
with the embedding interface.

Quantity comparison preserves sequential rounding during Base Unit conversion.
Large powers use logarithmic bounds, stable coefficient jumps and early merging
of equal rounded states. When those shortcuts cannot decide a comparison, work
is proportional to the Unit exponent. Thus some enormous powers, such as
comparing `1 min^10000000000000000000000000000000000000000` with `2` in the same
Unit, remain impractical to compare.

## The Go corpus runner

From `impl/go/`:

```sh
go run ./cmd/corpus --list
go run ./cmd/corpus
go run ./cmd/corpus quantities/value-encoding
go run ./cmd/corpus --check-passing
```

The runner passes the four Value Encoding cases, including Host NFC conversion.
It reports `SKIP` and a reason for unsupported kinds/features; explicitly
selecting an unsupported case fails. It has no blessing mode. Trace, disassembly
and transcript execution arrive with their backends; their setup files already
read, and tests parse every existing Trace, including filled keys. The front
end and lowering are checked independently as described above.

`corpus-passing.txt` is the CI gate: a listed regression or missing case fails;
an unlisted case that now passes is reported for addition. `go test` runs the
same gate. Setups accept the Corpus's TOML types (tables and arrays of tables,
inline tables, arrays, single-line strings, integers and booleans); other TOML
types are outside `case.toml`'s schema.
