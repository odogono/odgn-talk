# Changelog

Notable implementation changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with an Unreleased
section for work awaiting a release. Language and Cost Model versions are
tracked separately in the Spec's Data Files.

## [Unreleased]

### Added

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

- Apply the shared lint rules and formatting to TypeScript implementation and Spec tooling.

[Unreleased]: https://github.com/odogono/odgn-talk/commits/main/
