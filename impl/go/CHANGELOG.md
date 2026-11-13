# Changelog

Notable changes to `northtalk.org/go` and `northtalk.org/go/sqlite` are
recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with an Unreleased
section for work awaiting a release. `bun run changelog` lists the unreleased
fragments. Language and Cost Model versions are tracked separately in the
Spec's Data Files.

## [Unreleased]

## [0.2.0] - 2026-11-13

### Breaking

- **repo:** A Library replacement can keep every reloaded importer's mailbox, as a Reload's `keepMailbox` does: the kept messages go to the new code and count toward each Script's Persistent State cap, and the Trace's `replace-library` record writes `mailbox=keep`. In TS pass `replaceLibrary(library, carry, { keepMailbox: true })`, in Go `ReplaceLibrary(l, carry, ReloadOptions{KeepMailbox: true})`, and on the message layer `keepMailbox` on `replace-library`. In C, `talk_replace_library` now takes a `const talk_reload_options *` before `reports`; pass `NULL` to keep the old behaviour. Folio's Library Punch In now keeps its importers' mailboxes (#1951).

### Added

- **spec:** Scripts can make HTTP requests with `http`'s new `fetch` Operation, which gives the whole response as `{status, headers, body}` from an origin the Grant allows (ADR 0151). The Cores and Hosts implement it in later releases.
- **go:** `SetCompilationCacheDir(dir)` keeps the compiled Zig reactor in a directory for later processes, as `NORTHTALK_ZIG_CACHE_DIR` does, and wins over it. The reactor compiles once per process, so call it before the first Core needs the reactor; after that it fails (#1841).
- **spec:** Add bit Built-ins, `bitAnd`, `bitOr`, `bitXor`, `bitNot`, `bitShiftLeft`, `bitShiftRight`, `bitRotateLeft`, `bitRotateRight`, `bitCount` and `bitTest`, on whole numbers from 0 to 2^64 − 1 (#1852, ADR 0149).
- **go:** The Go module's embedded Zig reactor runs the ten bit Built-ins, `bitAnd` to `bitTest` (#1855).
- **go:** Let Scripts make HTTP requests with `http`'s `fetch` in the Go embedding. The embedded Zig Core checks the request, normalizes its URL and checks the Host's answer. `HTTPCapabilityWith` offers the server Operations, `fetch`, or both, and takes an `HTTPFetchImpl`, which hears the normalized URL and the request. `respond` now refuses header names repeated in different cases. The `northtalk` Script Runner fetches from any origin, with a `net/http` client that follows no redirect, decompresses nothing, bounds the response, verifies TLS and aborts abandoned calls (#1869).
- **go:** The embedded Zig Core accepts `on` and `with` as Argument Labels, and a labelled Operation call may leave out an Optional argument with its label (ADR 0160).
- **spec:** A labelled Operation call may leave out an Optional argument along with its label, which then arrives as Nothing, and `on` and `with` may be Argument Labels, so `loop "bd hh" with {gain: 0.5}` and `loop "c3" on bass with {gain: 0.5}` call the same Operation (ADR 0160).
- **go:** Go Hosts can offer the optional `peer` Standard Capability: `Core.PeerCapability` and the Core-fixed `Core.PeerKind`, running on the embedded Zig Core, which now routes a `send` to a Peer through the Script's `peer` Grant (#1973). `talk.h` gains `talk_peer_capability` and `talk_peer_kind`. Both Cores now charge a Remote Send at the `capability` rate, so its declared cost and its result's conversion count, as for any call to the Operation.
- **go:** Add an in-process peer router Example Host, in TS and Go, with tests that run two Groups through Remote Sends end to end (#1974). Go Hosts can now make a Peer inside a Host function, such as `Reach`'s answer, since `PeerCapability` declares the `peer` Object Kind to each Group's guest before it pumps.
- **go:** The Go `northtalk` Runner offers `peer`, with the TS Runner's `-listen`, `-peer` and `-peer-key` flags and the same wire, so Go and TS Runners carry Remote Sends to each other over mutual TLS or loopback TCP (ADR 0163, #1996).
- **spec:** Add the syntax error `reserved word`. A Reserved Word where a Name belongs, such as `put x into wait` or `on go end`, is now reported at the word, and the message says which word is reserved, instead of a generic `unexpected token` that `put 1 into replace` used to report at the end of the line (#2089).
- **go:** Refresh the embedded Zig Core, so Go Hosts get optional reads of Host Objects (#2093) and the `reserved word` syntax error that names the Reserved Word used as a Name (#2089).
- **spec:** A Reserved Word used as a Whose Key, as in `every item of xs whose end > 1`, now raises the syntax error `reserved word` at the word instead of `unexpected token` (#2095).
- **spec:** Add the syntax error `repeat with`. HyperTalk's counted loop, `repeat with i from 1 to n` or `repeat with i = 1 to n`, is now reported at `with`, and the message says to write `repeat for each i in 1..n`, instead of an `unexpected token` at `i` that pointed at `repeat 3 times` (#2097).
- **spec:** A Trace explains why no Handler Clause matched: the `run` record of a Run that ended `unhandled`, or that the Fallback Handler took, carries `mismatches`, with each named clause's reason (`arity`, `pattern`, `shape` or `guard`) and, for a Clause Shape, what `explain` gives. It's built only while tracing and charges nothing (ADR 0172, #2148).
- **spec:** Specify Clause Shapes: `on handle inv is an Invoice` skips the clause unless the argument fits the kind or named Shape, exactly as the same test at the start of its Guard would (ADR 0171).
- **spec:** Let an Elixir Host check a value against a Shape with `NorthTalk.conforms/3` and `NorthTalk.explain/3`, through a new `explain` message (#2197).
- **spec:** Let a Host load a Script with `forbidSuspension`, so that any possible Suspension Point in it is the load error `can't suspend here`.
- **go:** The embedded Zig Core is `reactor-v0.26.0`, so `LoadOptions.ForbidSuspension` refuses any possible Suspension Point in a Script as `can't suspend here`, and `ScriptView.ForbidSuspension` reports it.
- **go:** Let `Group.Object(kind, id, native, WithParent(p))` give a Host Object its parent when it is made, so a Host that makes Handles lazily inside a Pump can route a Script's send to the new object in the same Run (ADR 0152).
- **go:** Add `MusicalClockCapability` and `WithMusicalClock`, a `GroupOption` that `NewGroup` and `Restore` take, so a Go Host with a Transport can let its Scripts `wait 8 bars`. Without one, a `wait` in a Musical Unit raises `no musical time` (ADR 0166, #2065).
- **go:** The embedded Zig Core loads named Shapes: `shape Invoice is {type: text, amount: GBP}` declares a Constant holding the Shape's data, and `msg is an Invoice` tests a value as `conforms(msg, Invoice)` does. A malformed declaration is the load diagnostic `bad shape`, and a Constant named like another Constant, a function or a Script Variable is now a `name clash` (ADR 0168).
- **spec:** Let a Host give a Host Object its parent when it makes it, so a Script that gets a freshly made object from a Host function and sends to it in the same Run reaches the parent's Owning Script (ADR 0152).
- **spec:** Let a Host check a value against a Shape it built, with `conforms` and `explain` in the TS, Go and C embeddings; `explain` gives the `explain` Built-in's report (#2195).
- **spec:** Add the Musical Units `bar` and `beat`, so `wait 8 bars` waits until the Host's Transport reaches the 8th bar line, and add the frequency Units `Hz` and `kHz` and the pitch-interval Units `cent`, `semitone` and `octave` (ADR 0166, #2063).
- **spec:** Specify named Shapes: `shape Invoice is {type: text, amount: GBP, ref: optional text}` declares a Constant holding Shape data, and `msg is an Invoice` tests a value against it as `conforms` does (ADR 0168).
- **spec:** An Exposed Script can ask `caller` for the Caller Identity its Host vouches for, so a server knows who made a Remote Send (ADR 0154). Peers can now travel inside Remote Sends, and holding one is permission to send to it. `expose` gives a Peer, and without a name makes an unnamed exposure that only that Peer reaches, which a Script can hand out as a reply-to or push channel (ADR 0155). The Cores and Hosts implement both in later releases.
- **spec:** Scripts can send messages to Scripts in other Groups, on the same Host or another machine, with the ordinary `send` and `send … and wait`, through Peers from the new optional `peer` Standard Capability (ADR 0153). The Cores and Hosts implement it in later releases.

### Fixed

- **go:** The Go Session Host accepts `:script add`, so Scripts added to a session load beside the Session Script, as in the TS and Zig Hosts (#2141).
- **spec:** Say that `sqlite busy` and `store busy` can arise without a Fuel Slice when Groups sharing a database or Store are pumped at the same time, as a multi-tenant Go server does.
- **go:** A `peer` implementation with a `Release` method now hears each Grant's release, so the example peer router withdraws a stopped Script's exposures and frees their names (#2217).

### Performance

- **go:** Embed the Zig Core with fused fast steps, so Go Hosts run counting loops about 28% faster and `repeat for each` loops over Numbers 20–29% faster, with Fuel unchanged (#1931).

## [0.1.0] - 2026-10-30

The first published release of `northtalk.org/go` and `northtalk.org/go/sqlite`
(ADR 0148). It implements NorthTalk language 1.0-rc.3 by running the Zig Core
reactor `reactor-v0.15.0` under wazero, with no cgo.

### Added

- **go:** The root package embeds a Core, Groups, Scripts, Capabilities, Save and Restore, Partial Restore with `reload changed` and `keepMailbox`, and Traces; `driver` pumps many Groups on a worker Pool; `session` is the REPL and Transcript Host; `store` is an in-memory Store Capability; `notify` routes Store notifications.
- **go:** `northtalk.org/go/sqlite` implements the `sqlite` Standard Capability on `github.com/ncruces/go-sqlite3`.
- **go:** `CoreVersions()` reports the embedded reactor's release, `zig/0.15.0` (#1515).
- **go:** Supported on Go 1.26 or later; tested on Linux and macOS arm64, compile-checked on Windows and macOS amd64.
