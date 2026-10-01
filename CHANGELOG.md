# Changelog

Notable implementation changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with an Unreleased
section for work awaiting a release. Language and Cost Model versions are
tracked separately in the Spec's Data Files.

## [Unreleased]

### Added

- The Core's Group: Load with code identities and load diagnostics, queued Deliveries and Requests, Pumps that follow chapter 5's turns with Fuel Slices, debt and the Fuel cap, Persistent State at each Segment's end, Inspect, and a Trace sink writing chapter 11's records; and Trace Case replay and bless in the corpus runner, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- The Core's Abstract Machine: loading code units, Handler Clause dispatch, calls and Lambdas, unwinding through the Unwind Table, Cost Model 0 Fuel and allocation with Limit Faults and rollback, exact decimal arithmetic, chunks, properties, Built-ins, and Text Patterns on chapter 8's Pike VM, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- Core normative lowering of checked Scripts and Libraries onto chapter 8's code units (constant pool, definitions, variables, objects, body table, code, Unwind Table and event table), with the canonical disassembly, generated instruction tables, a structural check of every lowered source against `machine.toml`, and explicit-stack passes for deep source, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- Disassembly Cases under `corpus/disassembly/`, together emitting every instruction, and corpus runner support for running them and for `--bless`ing their expected files.

- Core construct and Guard diagnostics: duplicate map keys, number literal limits, unknown kinds and impossible conversions, misplaced `ignoring case` and `delimited by`, Text Pattern Captures in repetitions and invalid `as number`, misplaced rests, partial-byte bit runs, Script `private` declarations and Guard calls, Lambdas and Host Object properties, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- Core control-flow and body-context diagnostics: misplaced `exit repeat`/`next repeat`, transfers that leave `finally`, `pass` and `the target` inside Lambdas, `pass` naming another message, and invalid Handler suffix combinations, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- Core read-only Constant and Lambda capture checks, bare-variable `set` diagnostics, named function argument contracts, default ordering and initializer/default reference checks with exact diagnostic positions and ordering, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- Core name resolution with typed semantic trees, source spans, whole-body local collection, Lambda captures, and exact ordered load-time diagnostics for invalid names, clashes and duplicate bindings, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- A lossless Core modal lexer and predictive parser, with typed concrete syntax trees, original token/trivia spans, exact source reconstruction and first-error syntax diagnostics for [#126](https://github.com/odogono/odgn-talk/issues/126).
- Browser-safe generated syntax/Unit tables, regeneration checks and Core parsing tests covering diagnostic fixtures, corpus Scripts, Standard Libraries and documentation examples.

- The first TypeScript Core value foundation for [#126](https://github.com/odogono/odgn-talk/issues/126): generated, pinned Unicode 18 tables for NFC normalization, Character boundaries and case mapping.
- Immutable public text, number, boolean, Nothing, list and map values, with canonical display and Value Encoding readers and writers.
- Text helpers for NFC joins, scalar ordering, whole-Character literal searches and chunk splitting.
- Unicode conformance tests, value round-trip tests, an execution runner for the NFC encoding case, and a browser bundle with a smoke test.
- Type checks and implementation checks in CI, alongside the existing Spec checks.
- TypeScript linting with ESLint and `@nkzw/eslint-config`, formatting with Prettier, and CI checks for both.

### Changed

- The `text-model/` Trace Cases are blessed by the TS Core, with Cost Model 0's Fuel, allocation and Persistent State figures and their code identities, and run in CI ([#126](https://github.com/odogono/odgn-talk/issues/126)).
- Apply the shared lint rules and formatting to TypeScript implementation and Spec tooling.

[Unreleased]: https://github.com/odogono/odgn-talk/commits/main/
