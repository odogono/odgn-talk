# Go Core values and foundations

The Go Core is module `github.com/odogono/odgn-talk/impl/go`, with public root
package `northtalk`. It supplies immutable values and their Host constructors
and accessors, decimal
arithmetic, the display form and its reader, plain JSON and the Value Encoding,
and internal Unicode text primitives:
strict UTF-8 validation, NFC, extended grapheme cluster (Character) boundaries,
simple case folding, and the Spec's White_Space-based words and word breaks.
Source parsing and the execution interface are not yet implemented. The Spec
and Data Files are the authority; the TS Core is not a
reference ([ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

## Layout

- The root package owns the [embedding interface](../../spec/embedding/talk.go).
  `value.go` and `encoding.go` implement the value and codec declarations.
  `text.go` holds `Text`'s uncharged, UTF-8-validating NFC seam.
  No unimplemented public declaration is stubbed.
- `internal/unicode/` holds the text primitives. Its spans and boundaries use
  zero-based UTF-8 byte offsets; Script positions will count Characters. It
  segments text as given, without normalizing the entire source.
- `internal/generated/` holds checked-in tables written from the Spec Data
  Files and pinned Unicode sources, with `UNICODE-LICENSE.txt` beside them.
- `internal/apicheck/` checks root exports and their declarations against
  `talk.go`, allowing private named fields for opaque types. Anonymous
  embeddings are compared even when private, because they can promote public
  members. Unimplemented
  Spec names are reported without failing until #141.
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
- `syntax/`, `check/`, `lower/`, `machine/` and `trace/` reserve the remaining
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
bun run go:generate       # Core catalogues, corpus formats and pattern vocabulary
bun run unicode:generate # both Cores' Unicode tables and licenses
bun run syntax:generate  # TS syntax tables and the Go Data File tables
bun run check            # checks every generated output against its sources
```

The Go emitter in `tools/go/` reads only `spec/data/`; it imports no TS Core
code. The Unicode generator parses the pinned UCD once for both output formats.
The emitters use `gofmt`, so Go must also be installed for generator commands.
Each generator's `--check` refuses missing or stale Go output without rewriting
it. `bun run go:check` checks the non-Unicode Go tables independently.

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
read, and tests parse every existing Trace, including filled keys.

`corpus-passing.txt` is the CI gate: a listed regression or missing case fails;
an unlisted case that now passes is reported for addition. `go test` runs the
same gate. Setups accept the Corpus's TOML types (tables and arrays of tables,
inline tables, arrays, single-line strings, integers and booleans); other TOML
types are outside `case.toml`'s schema.
