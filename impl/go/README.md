# Go Core foundations

The Go Core is module `github.com/odogono/odgn-talk/impl/go`, with public root
package `northtalk`. It currently supplies internal Unicode text primitives:
strict UTF-8 validation, NFC, extended grapheme cluster (Character) boundaries,
simple case folding, and the Spec's White_Space-based words and word breaks.
The public value constructors, parser and execution interface are not yet
implemented. The Spec and Data Files are the authority; the TS Core is not a
reference ([ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

## Layout

- The root package owns the [embedding interface](../../spec/embedding/talk.go).
  `text.go` holds the uncharged, UTF-8-validating NFC seam for the future `Text`
  constructor. No unimplemented public declaration is stubbed.
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
- `internal/decimal/`, `syntax/`, `check/`, `lower/`, `machine/`, `trace/` and
  `corpus/` reserve the implementation boundaries agreed on [#132](https://github.com/odogono/odgn-talk/issues/132).

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
bun run go:generate       # machine, costs, errors, diagnostics, limits, units, version
bun run unicode:generate # both Cores' Unicode tables and licenses
bun run syntax:generate  # TS syntax tables and the Go Data File tables
bun run check            # checks every generated output against its sources
```

The Go emitter in `tools/go/` reads only `spec/data/`; it imports no TS Core
code. The Unicode generator parses the pinned UCD once for both output formats.
The emitters use `gofmt`, so Go must also be installed for generator commands.
Each generator's `--check` refuses missing or stale Go output without rewriting
it. `bun run go:check` checks the non-Unicode Go tables independently.
