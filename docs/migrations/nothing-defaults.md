# Nothing defaults migration

Language **1.0-rc.3** adds `otherwise` and optional map-key reads, and
retains provisional **Cost Model 0**. The TS, Go and Zig Cores and the shared
tooling (formatter, LSP, debugger and highlighting) implement them
([chapter 4](../../spec/04-expressions-and-statements.md#nothing-defaults)).
Moving from 1.0-rc.2 changes every code identity and Group Fingerprint:
recompile Libraries and regenerate pinned identities and corpus expectations.

- Rename any Argument Label `otherwise` in declarations, event heads, calls,
  `pass` and target-first sends. Update dynamic Selector strings and Host
  message producers and consumers together. Old sends may silently select
  a different message: `move a otherwise b` now passes one default expression
  to `move`, rather than sending `move:otherwise:`.
- Group an index variable named `otherwise`: change `item otherwise of xs`
  to `item (otherwise) of xs`.
- Variables, functions, Handlers and map keys named `otherwise` remain legal.
  `the optional of m` still reads the ordinary key `optional`. The Go Core
  doesn't yet load a Script with both a Handler and a local of one name
  ([#764](https://github.com/odogono/odgn-talk/issues/764)).

`a otherwise b` defaults only Nothing and evaluates `b` lazily. For every
nullable map step, write `the optional k of x`; no optional form reads Host
properties or writes a Container. `lookup` remains available for eager
fallbacks, list positions and whole-path validation.

A 1.0-rc.2 save is a version mismatch on a 1.0-rc.3 Core: `RejectMismatch`
refuses it with `save mismatch`, and `VariablesOnly` restores its Script
Variables and discards its Runs and queued messages
([chapter 10](../../spec/10-save-and-restore.md#restoring)). There is no
automatic snapshot or Selector migration.
