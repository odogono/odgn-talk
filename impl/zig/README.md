# Zig Core

The Zig Core is a third NorthTalk Core for embedding outside Go and TS: natively
through the C API in [`include/talk.h`](include/talk.h), and as a `wasm32-wasi`
module for Hosts with a WASM runtime
([ADR 0078](../../docs/adr/0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md)).
It is written from the Spec, its Data Files and the Conformance Corpus, never
translated from the Go or TS Core
([ADR 0071](../../docs/adr/0071-a-third-core-serves-embedding-outside-go-and-ts-after-the-message-layer-is-measured.md),
[ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)). The
design decisions that bind it are recorded on
[#625](https://github.com/odogono/odgn-talk/issues/625#issuecomment-6111271797).

It is under construction, step by step through
[Appendix B](../../spec/appendix-b-implementation-order.md). So far it has its
generated tables, Unicode text primitives, reference-counted values, native
decimal arithmetic, the display form, the Value Encoding, a corpus runner, and
the front end's lexer, lossless parser, checker and lowering, and the first
part of the Abstract Machine, driven through `talk.h`.

Use the [Zig task map](NAVIGATION.md) for implementation files, Spec links,
tests and check commands.

## Layout

- `build.zig`, `build.zig.zon`: one Zig package, `northtalk`, pinned to Zig
  0.17.0 by `minimum_zig_version`. It uses Zig's standard library only: no
  third-party packages and no linked C libraries.
- `include/talk.h`: the C API. It mirrors
  [`spec/embedding/talk.go`](../../spec/embedding/talk.go)'s names in C style,
  as [`tools/zig/api.ts`](../../tools/zig/api.ts) spells them, and declares only
  what the Core implements.
- `src/root.zig`: the package root. [`src/talk.zig`](src/talk.zig) holds
  `talk.h`'s exports.
- `src/unicode/`: UTF-8, NFC, Characters (extended grapheme clusters), simple
  case folding, and the `word` and `word break` rules, built only on the
  generated tables.
- `src/generated/`: tables written from the Data Files and the pinned Unicode
  data. Never edit them by hand.
- `src/decimal/`: chapter 3 decimals and exact rational arithmetic.
- `src/value.zig`, `src/units.zig`, `src/dates.zig`: immutable values,
  copy-on-write containers, catalogue Units and Gregorian dates.
- `src/display.zig`, `src/encoding.zig`, `src/pattern.zig`: the display reader
  and writer, lossless Value Encoding and canonical Pattern source reader.
- `src/syntax/`: the modal lexer of chapter 1 and the predictive parser of
  chapter 2, which builds a lossless syntax tree.
- `src/check/`: the checker, which raises chapter 2's load-time diagnostics
  and resolves the names the lowering reads.
- `src/lower/`: the normative lowering of chapter 8 to `machine.toml`'s
  instructions, and the canonical disassembly.
- `src/corpus/`: case discovery, metadata, encoding replay, Trace parsing,
  case setup and Disassembly Cases.
- `src/machine/`: the Abstract Machine: Groups, Scripts, Runs and frames,
  the run loop, Cost Model 0 charging, chunks and properties, the Built-ins it
  has so far, and Trace writing.
- `tests/`: C programs that use `talk.h` as a Host would.

`session` and the REPL join `src/` in step 6.

## Syntax

The parser drives the lexer: it names the mode of every token it asks for,
reads at most two tokens ahead for the decisions `grammar.toml` lists, and
stops at the first syntax error with its code and position. A lexical error
comes back as an `invalid` token, so a parser that has peeked past the token
it fails at still reports that one. Fenced text is scanned whole when its
opener is lexed, holes and nested literals included, and each literal is
remembered by its offset, so nested interpolation stays linear. Margins,
escapes and line breaks are decoded then; NFC is left to the value.

Every token, line breaks and the end of the source included, is kept in
source order, and a backtick literal with holes is split into pieces around
its holes' tokens. `Tree.reconstruct` rebuilds the source byte for byte from
them. The tree's shape is the Zig Core's own.

Source nesting is bounded at 128 recursive parser regions, and an expression
tree at 128 levels, so hostile source ends in `source nesting too deep`, never
a stack overflow. Like the Go Core's limit, that code is an implementation
limit outside the Spec's catalogue.

## Checking

`check.check` takes a parsed unit and a `Context`: whether it is a Library,
the well-known objects, the Script's Grants and the Group's Libraries. It
returns every load-time diagnostic, ordered by position and then by
`diagnostics.toml`'s order, with what each Name refers to, each body's locals
and captures, and which Handlers may suspend. `check.exports` gives what a
checked Library exports to its importers. The stdlib Libraries' exports and
the Built-ins come from `stdlib.toml`.

A Handler may suspend when a clause holds a written Suspension Point, or a
Command Call to a Handler that may, found over the call graph to a fixpoint.
That decides `missing and wait`, `needless and wait` and `can't suspend here`.
A `, deciding` Handler's `veto` and `pass` are checked over every path through
its body for `after a suspension`.

Capability calls, `say` included, are checked only when the `Context` gives
the Grants, and `wrong argument` (a literal against an Operation's Shape),
`missing grant`,
`import cycle`, `pattern too large` and `initialiser failed` are not raised
yet: they need the Group's Shapes and Library graph, Text Pattern programs, and
a run of the initialiser, which later parts of step 1 and step 2 bring.

## Lowering

`lower.lower` turns a unit that checks clean into a code unit: its constant
pool, definitions, variables, objects, body table, code, Unwind Table, offer
records and event table, each instruction with its source position.
`lower.disassemble` prints its canonical disassembly. The in-memory
instructions are the Zig Core's own (ADR 0009), and nothing outside `src/`
depends on them.

Each body is lowered into its own buffer, with labels local to it, and the
buffers are laid out in body order at the end. A Lambda or an event test is
numbered and lowered where the lowering reaches it, so its constants and
nested bodies are numbered there too. Temps take the lowest free slot; a catch
handler's dispatch slots start above every slot the protected body used.
Every inlined copy of a `finally` block, and the exit after it, is cut out of
the spans of the `try`s it leaves, so an entry split by copies becomes one
entry per span. The Operation modes that pick `ask`, `ask-wait`, `join-ask`
or `tell` come from the Context's Grants.

A Container written through a Built-in property, such as `put 1 into the
length of x`, still parses and is written as a key of that name. This
placeholder diverges from chapter 2's required `not a container` syntax
rejection; parser enforcement and its removal are tracked in
[#673](https://github.com/odogono/odgn-talk/issues/673).

## Building and testing

Run these from `impl/zig/`, after `bun install --frozen-lockfile` and
`bun run unicode:check` at the repository root. The Unicode check downloads and
verifies the pinned UCD files the tests read.

```sh
zig build test                    # the Zig tests and the talk.h C tests
zig build                         # zig-out/lib/libtalk.a and zig-out/include/talk.h
zig build -Dtarget=wasm32-wasi    # zig-out/bin/talk.wasm
zig build corpus -- --check-passing
zig build corpus -- --list
zig build corpus -- bytes/value-encoding
zig fmt --check .
```

Every build is `-Doptimize=safe` (ReleaseSafe) unless told otherwise, so bounds
and integer overflow stay checked while the Core reads hostile input.
`-Doptimize=fast` is refused.

Zig 0.17 renamed standard library APIs that older examples and documentation
still use. Check names against the installed source, under `lib_dir` from
`zig env`, rather than online docs:

- `std.builtin` is an alias for `std.lang`, defined in `std/lang.zig`.
- Optimize modes are `debug`, `safe`, `fast` and `small`, so the flags are
  `-Doptimize=safe` and so on.
- `std.testing.refAllDeclsRecursive` is gone; use `refAllDecls` per container.
- `@typeInfo` of an enum gives `field_names` and `field_values`, not `fields`.

The `wasm32-wasi` target builds a WASI reactor: a module with no `_start` that
exports `talk.h`'s functions. A Host instantiates it once per instance and calls
the exports directly.

From the repository root, `bun tools/zig/api.ts` compares `talk.h` with
`talk.go`. It fails on a `talk.h` name that `talk.go` doesn't declare, unless
the declaration is marked `C only`, and lists the `talk.go` names `talk.h`
doesn't declare yet. Those fail only from step 6's conformance gate.

## The machine

`talk_new`, `talk_new_group`, `talk_load`, `talk_script_deliver`,
`talk_script_request`, `talk_pending_result`, `talk_pump` and `talk_inspect`
drive a Group. A Group's Trace reaches the Host's `talk_trace_sink` one line at
a time. Loading a Script parses, checks and lowers it, runs its initialiser
uncharged and writes its `load` record with its code identity, or its `diag`
records and `TALK_LOAD_REFUSED`. Grants, objects, Libraries, limits and Fuel
Slices aren't reachable through `talk.h` yet.

A Pump writes and drains the queued Deliveries and Requests, then runs each
Script's mailbox: each Run tries its Handler's clauses in order, charging the
`clause` rate at each clause's first instruction. Frames are on the heap, so
the run loop never recurses on Script depth. Every instruction is charged by
its `machine.toml` cost key, or `builtin.<name>`, from the generated Cost Model
0 terms, with `scanned` reported by the operation itself, and Persistent State
is measured over the Script Variables and the mailbox at a Segment's end.

So far the machine runs straight-line code, branches, loops, functions, chunks
and properties, keys, lists and maps, `match` with its destructuring tests,
Bytes builds and Binary Patterns, `as` conversions, and a few Built-ins. A
raised error unwinds in two phases: the catch search walks the Unwind Table
outward, charging `unwind` per frame it leaves and running each catch test in
a dispatch activation over the owner's locals, then the exited `finally`
blocks run, innermost first. An uncaught error ends the Run and queues an
`error` message to the Script's own mailbox, for its `on error` Handler. Core
messages are left out of the Trace, since their wording is outside parity.

`contains`, `begins with` and `ends with` with a text or Bytes needle run it as
a literal program and count the matcher's `steps` ([literal](src/machine/literal.zig)).
The full Text Pattern matcher, Lambdas, waits, messages between Scripts and
Capabilities come next. A Run past the default Fuel per Run ends in a minimal
`fault` until step 4 brings limits.

## Values and ownership

`talk.h` implements Nothing, Bool, Text, Int, Uint, FromFloat, Dec, Quantity,
CivilDate, ParseCivilDate, Instant, Bytes, List, Map and Range, and their value
and Decimal accessors. Number text is checked before arithmetic, including
linear rejection of oversized inputs. Arithmetic uses native Zig integers
and arbitrary-precision rational intermediates, with one half-even rounding
and the operator's ideal exponent. Addition, subtraction, multiplication,
division, `div`, `mod` and `^` are available internally, and `^` is also
`power(x, y)`. An integer exponent of any size gives the exact power, rounded
once; any other exponent gives the correctly rounded result with trailing
zeros dropped. Noninteger powers bound e^(y ln x) in fixed point and add
precision until both bounds round alike, after exact results and ties are
found directly. Results that overflow or round to zero are settled from their
magnitude, so huge exponents stay cheap.

Each returned value owns one reference. Constructors copy byte input and
retain child values; text and map keys become NFC. Map keys preserve insertion
order and refuse NFC duplicates. Container writes rebind the root, preserving
aliases and preventing cycles, including insertion of the previous root into
its replacement. Every node remembers its allocator, so Zig tests use the
leak-detecting test allocator. C values use the process allocator; Group
allocation belongs to the execution API. Handles require Host synchronization
when shared across threads.

Text and Decimal accessor pointers borrow their value. Byte accessors copy
out, and display, encoding and canonical Unit strings return an owned
`talk_owned_bytes`, released with `talk_owned_bytes_release`. Child accessors
return owned references; the header documents each lifetime. Encoding refuses
Function Values at any depth and resolves Host Objects through the decoder's
callback. Decoding accepts only the forms the encoder writes: a decoded value
must re-encode to the number, tag and payload the input spelled, so `{"$dec":
"3"}`, `1.0` and a non-UTC or non-shortest `$instant` are refused. JSON white
space and string escapes are syntax, and text is normalised to NFC. Pattern
decoding reparses canonical source; compilation and matching belong to the
front end. Value construction and decoding guard nesting at 128
levels, independently of future Run budgets.

## Corpus runner

`zig build corpus -- [--list] [--check-passing] [case directory ...]` discovers
all case kinds and runs encoding cases through `talk.h`, and Disassembly
Cases through the front end, since `talk.h` exposes no compiled unit, with the
Go runner's messages. It holds each `case.toml` to the language and Cost Model versions
and to the tables and keys that [corpus.toml](../../spec/data/corpus.toml)
allows for its kind. Selectors may name a category or a case, with or without
a `corpus/` prefix. `--list` prints each case's kind and whether it is
supported or deferred, and a failure prints the first divergent line and the
command that reproduces it. [The case setup reader](src/corpus/case.zig)
builds each Script's Grants, with their modes and arities, from the case's
Operation Declarations and Standard Capabilities. Trace Cases replay through
`talk.h` alone ([`talk_replay.zig`](src/corpus/talk_replay.zig)) when they need
only loads, Deliveries and Requests to Scripts, Pumps and `vars`, and no
Grants, objects or Libraries. Transcript replay and encoding cases that
register Host Objects are not supported.

`--check-passing` takes no selection. `corpus-passing.txt` lists the cases the
Zig Core must pass in CI: a listed case that fails, disappears or is
unsupported fails the gate. Unlike the Go gate, a case that isn't listed is
reported and skipped when it is unsupported or doesn't pass yet, as the
decisions on #625 say, since the machine grows case by case. A passing case
that isn't listed prints `NEW PASS`, for adding to the list. Expected corpus
bytes are never rewritten. The runner's replay backend says which cases it
supports and replays each from its directory;
[Trace parsing](src/corpus/trace.zig) uses generated record/key metadata,
including filled input keys and optional ids, for the comparison.

## Regenerating tables

[`tools/zig/generate.ts`](../../tools/zig/generate.ts) writes the catalogues
and compiled Cost Model terms from `spec/data/*.toml`, and
[`tools/unicode/generate.ts`](../../tools/unicode/generate.ts) writes
`unicode.zig` and its `UNICODE-LICENSE.txt` from the pinned UCD. Neither reads
another Core.

```sh
bun run zig:generate        # the catalogues
bun run unicode:generate    # the Unicode table, for every Core
```

The catalogues include `grammar.toml`'s word lists, which the parser reads,
and `stdlib.toml`'s Built-ins and stdlib Library exports, which the checker
reads.
`bun run check` holds both to their sources and fails on a stale table. The
emitters write `zig fmt`'s canonical form themselves, so the check needs no Zig
toolchain; CI's `zig fmt --check` holds them to it.
