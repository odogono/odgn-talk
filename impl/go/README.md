# Go Core

The Go Core is module `github.com/odogono/odgn-talk/impl/go`, with public root
package `northtalk`. It provides immutable values, decimal arithmetic, pinned
Unicode text, a front end and standalone Abstract Machine execution. Its internal machine executes checked code; the public Group embedding and
Trace backends are supplied by the next layer of #251. The Spec, Data Files and Conformance Corpus are
the authority; the TS Core is not a reference
([ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

## Layout

- The root package implements the available declarations of the
  [embedding interface](../../spec/embedding/talk.go). `value.go`, `encoding.go`
  and `text.go` own immutable values and codecs. Public Group execution is
  supplied by the next layer.
- `internal/generated/` holds tables from Spec Data Files and pinned Unicode
  sources, with `UNICODE-LICENSE.txt` beside them.
- `internal/unicode/` supplies NFC, Character boundaries, simple folding, full
  default case mappings and White_Space-based words. Spans use zero-based UTF-8
  byte offsets; Script source positions count scalars from line and column 1.
- `internal/decimal/` supplies exact-input decimals, arithmetic, integral
  rounding and elementary functions. Outward-rounded intervals increase
  precision until both bounds select the same 34-digit half-even result.
- `internal/value/` owns values, Units, comparison, display and strict JSON.
  Containers copy input slices; public accessors return copies.
- `internal/syntax/` owns lossless UTF-8 lexing and parsing. `Tree.Source()`
  reconstructs every source byte; only Text literal values are NFC.
- `internal/check/` resolves declarations, body slots, captures and initializer
  dependencies. Diagnostics sort by source position, then catalogue order.
- `internal/lower/` produces canonical instructions, source maps, Unwind Tables
  and Event Tables. Labels use instruction indices, never byte offsets. Its
  Go-private byte encoding round-trips each body's instruction stream.
- `internal/machine/` executes checked code with heap frames, detached operand
  evaluation, clause dispatch, unwind state and generated Cost Model 0 charges.
- `internal/trace/` reserves the canonical Trace writer boundary.
- `internal/corpus/` reads setups and runs encoding cases. `cmd/corpus/` provides
  selection, first-divergence output and the gate.
- `internal/apicheck/` compares root exports and signatures with `talk.go`,
  including promoted members. Missing declarations are reported without failing
  until [#141](https://github.com/odogono/odgn-talk/issues/141).

The module has no third-party requirements and no `go.work`. Session tooling
belongs to [#137](https://github.com/odogono/odgn-talk/issues/137); the planned
`session/`, `driver/` and `cmd/northtalk/` boundaries follow
[ADR 0046](../../docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md).

## Build and test

Use Go 1.27 and Bun 1.4.2. From the repository root:

```sh
bun install --frozen-lockfile
bun run unicode:check
cd impl/go
go build ./...
go vet ./...
go test -race -v ./...
go run ./cmd/corpus --check-passing
gofmt -l .               # must print no paths
```

Unicode tests verify source hashes in `.cache/unicode/18.0.0/`, all five columns
of `NormalizationTest.txt`, scalars absent from its first column, every
`GraphemeBreakTest.txt` row and C/S folding against `CaseFolding.txt`. Missing or
corrupt sources fail. The import-policy test refuses platform Unicode tables,
`strings` case functions and `golang.org/x/text`.

Regenerate from the repository root:

```sh
bun run go:generate
bun run unicode:generate
bun run syntax:generate
bun run check
```

Emitters read Spec Data Files and pinned UCD sources, import no TS Core code and
use `gofmt`. Their `--check` modes refuse missing or stale output without writing.

## Front-end and lowering checks

Tests reconstruct every grammar sketch, Corpus source and stdlib Library,
and pin the first errors in `tools/grammar/broken.talk`. The seven units in the
six Disassembly Cases match byte for byte, including pools, slots, positions,
Unwind Tables and Event Tables; together they emit every declared opcode.
Stdlib signatures can be linked for disassembly without executing Libraries.
Tests pin the 30 load-diagnostic cases. Initializer failure identifies the
raising instruction's source-map position. Public `Load` and runner backends
arrive in the next layer.

Implicit Script Variable initializers allocate Nothing slots without emitting
stores. Explicit `= nothing` emits its constant and store, as chapter 8 requires.
This keeps canonical code positions aligned with the existing Corpus.

Handler call-graph analysis, Library linking, Grants, Capability modes and Host
Object property Shapes belong to
[#134](https://github.com/odogono/odgn-talk/issues/134). The diagnostic families
`wrong argument`, `unknown operation`, `wrong mode`, `missing and wait`,
`import cycle`, `missing grant`, `not in a library`, `veto outside a decision`,
`after a suspension`, `wrong message` and `bad suffixes` depend on those facilities.

## Values and codecs

`Dec` reads number syntax without rounding. `FromFloat` uses shortest round-trip
digits. Decimal printing retains trailing zeros; integer accessors refuse
fractions and overflow, and `Float64Lossy` rounds nearest, ties to even.
Constructors reject invalid input with `HostError{Code: InvalidValue}`.
`InstantFromTime` drops zone and monotonic readings and panics with that Host
error outside years 0001–9999; `Instant` returns the refusal instead.

`Value.String` uses chapter 11's display form. `EncodeValue` preserves supported
kinds and numeric exponents. `DecodeValue` rejects malformed UTF-8, lone
surrogates, duplicate NFC keys and noncanonical Base64, re-parses Text Patterns
and resolves Object tags through its resolver. Plain JSON refuses non-JSON
kinds with `not encodable`, including `kind` and the first depth-first `path`.
Function Values have Home identity, capture equality and accessors, and are
refused by storage encoding. Object registration belongs to #134.

Quantity comparison retains sequentially rounded Base Unit magnitudes beyond
the number limit. Some huge Unit exponents remain impractical when interval
bounds and stable-coefficient shortcuts cannot decide the comparison.

## Machine execution

`machine.Initialize` evaluates initializers without Run charges.
`InitializeBound` supplies Home identity before creating Function Values.
`StartDelivery` tries arity-compatible Handler Clauses in source order; local
Handler calls use the same clause-failure rules. `Run.Execute` returns between
instructions on preemption, keeping frames, locals, stacks and unwind state as
plain data. It uses no saved Go callback or goroutine continuation.

Standalone execution covers chapter 3/4 arithmetic, Quantities and dates,
conversions, folded structural comparison, containers and writes, snapshot
iteration, branches, loops, catch/finally, binary construction/destructuring,
Text Patterns and replacement, and non-suspending local Function Values with
captures and named defaults. The Built-ins include number functions, IEEE float
codecs, pinned case mapping, date fields and fixed-offset conversion, and Function
Value metadata. Object lifecycle Built-ins depend on #134.

Generated Cost Model 0 charges precede committed instruction changes. Fuel,
allocation, depth and dynamic Pattern Size faults leave the faulting instruction
uncharged and restore Script Variables to the Run's starting snapshot. Range
materialization and padding have budget preflights before construction.
Persistent State counts variables, mailboxes and retained Run frames; a final
return checks the state that will remain. Cancellation runs finally cleanup
under its separate Cleanup Budget. Execution tests cover each chapter area and
pin the text-model fixtures' Fuel, allocation, positions and final variables.

Suspension, messages, imported calls, Capability effects and Object properties
stop at a `Blocked` implementation boundary with the instruction and operands
untouched and no charge for that instruction. The caller retains the pending Run. Full Handler modes, automatic `error` delivery,
Message Paths and scheduling belong to #134; complete cancellation and Stop
Script acceptance to [#135](https://github.com/odogono/odgn-talk/issues/135),
and save/restore to [#136](https://github.com/odogono/odgn-talk/issues/136).

## Corpus runner

From `impl/go/`, run `go run ./cmd/corpus --check-passing`. The runner gates the
four Value Encoding cases and has no blessing mode. The internal machine tests
run the ten text-model Script fixtures through the Go front end, checking final
variables, Fuel, allocation, state and canonical raise positions. The public
embedding and Trace replay layer of #251 connects these executions to the runner.
