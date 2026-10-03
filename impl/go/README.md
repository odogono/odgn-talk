# Go Core

The Go Core is module `github.com/odogono/odgn-talk/impl/go`, with public root
package `northtalk`. Its internal front end lexes UTF-8 source, parses a lossless tree, resolves
names and bindings, and lowers checked units into the Abstract Machine's
instructions, source maps, Unwind Tables and Event Tables. It also supplies
pinned Unicode text primitives: NFC, extended grapheme cluster (Character)
boundaries, simple case folding, and White_Space-based words and word breaks.
Public value constructors, loading and execution arrive in the later steps;
no unimplemented public declaration is stubbed. The Spec and Data Files are the authority; the TS Core is not a
reference ([ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

## Layout

- The root package owns the [embedding interface](../../spec/embedding/talk.go).
  `text.go` holds the uncharged, UTF-8-validating NFC seam for the future `Text`
  constructor. No unimplemented public declaration is stubbed.
- `internal/unicode/` holds the text primitives. Its spans and boundaries use
  zero-based UTF-8 byte offsets; Script positions count Unicode scalars, starting at line and column 1. It
  segments text as given, without normalizing the entire source.
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
- `internal/decimal/`, `machine/`, `trace/` and `corpus/` reserve the remaining
  implementation boundaries agreed on [#132](https://github.com/odogono/odgn-talk/issues/132).

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
bun run go:generate       # machine, costs, errors, diagnostics, limits, units, version, grammar, Built-ins
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

Go tests reconstruct every grammar sketch, Corpus source and stdlib Library, and pin
all first errors in `tools/grammar/broken.talk`. The seven units in the six
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
These tests serve as the checks until the runner from
[#249](https://github.com/odogono/odgn-talk/issues/249) lands. Once it lands,
register the six Disassembly Cases and diagnostic cases on its passing list.

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
