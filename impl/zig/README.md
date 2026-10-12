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
decimal arithmetic, the display form, the Value Encoding and a corpus runner.

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
- `src/corpus/`: case discovery, metadata, encoding replay and Trace parsing.
- `tests/`: C programs that use `talk.h` as a Host would.

`syntax`, `check`, `lower`, `machine` and Trace writing join
`src/` in the later parts of step 1, and `session` and the REPL in step 6.

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

The `wasm32-wasi` target builds a WASI reactor: a module with no `_start` that
exports `talk.h`'s functions. A Host instantiates it once per instance and calls
the exports directly.

From the repository root, `bun tools/zig/api.ts` compares `talk.h` with
`talk.go`. It fails on a `talk.h` name that `talk.go` doesn't declare, unless
the declaration is marked `C only`, and lists the `talk.go` names `talk.h`
doesn't declare yet. Those fail only from step 6's conformance gate.

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
all case kinds and runs encoding cases through `talk.h`, with the Go runner's
messages. It holds each `case.toml` to the language and Cost Model versions
and to the tables and keys that [corpus.toml](../../spec/data/corpus.toml)
allows for its kind. Selectors may name a category or a case, with or without
a `corpus/` prefix. `--list` prints each case's kind and whether it is
supported or deferred, and a failure prints the first divergent line and the
command that reproduces it. Trace execution, disassembly, Transcript replay
and encoding cases that register Host Objects are not supported.

`--check-passing` takes no selection. `corpus-passing.txt` lists the cases the
Zig Core must pass in CI: a listed case that fails, disappears or is
unsupported fails the gate, as does a supported case that fails. Unlike the Go
gate, an unsupported case that isn't listed is skipped. A passing case that
isn't listed prints `NEW PASS`, for adding to the list. Expected corpus bytes
are never rewritten. The runner's `run` accepts a Trace replay callback, and
hands it each case's `case.toml` as raw TOML;
[Trace parsing](src/corpus/trace.zig) uses generated record/key metadata,
including filled input keys and optional ids, so machine execution can plug
into the same comparison and passing-list gate.

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

`bun run check` holds both to their sources and fails on a stale table. The
emitters write `zig fmt`'s canonical form themselves, so the check needs no Zig
toolchain; CI's `zig fmt --check` holds them to it.
