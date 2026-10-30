# Changelog

Notable changes to `northtalk.org/go` and `northtalk.org/go/sqlite` are
recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with an Unreleased
section for work awaiting a release. `bun run changelog` lists the unreleased
fragments. Language and Cost Model versions are tracked separately in the
Spec's Data Files.

## [Unreleased]

## [0.1.0] - 2026-10-30

The first published release of `northtalk.org/go` and `northtalk.org/go/sqlite`
(ADR 0148). It implements NorthTalk language 1.0-rc.3 by running the Zig Core
reactor `reactor-v0.15.0` under wazero, with no cgo.

### Added

- **go:** The root package embeds a Core, Groups, Scripts, Capabilities, Save and Restore, Partial Restore with `reload changed` and `keepMailbox`, and Traces; `driver` pumps many Groups on a worker Pool; `session` is the REPL and Transcript Host; `store` is an in-memory Store Capability; `notify` routes Store notifications.
- **go:** `northtalk.org/go/sqlite` implements the `sqlite` Standard Capability on `github.com/ncruces/go-sqlite3`.
- **go:** `CoreVersions()` reports the embedded reactor's release, `zig/0.15.0` (#1515).
- **go:** Supported on Go 1.26 or later; tested on Linux and macOS arm64, compile-checked on Windows and macOS amd64.
