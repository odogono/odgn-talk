# Nothing defaults migration

The TS Core and shared tooling implement `otherwise` and optional map-key
reads. The coordinated integration targets language **1.0-rc.3** and retains
provisional **Cost Model 0**. Runtime version activation, Trace headers,
Group Fingerprints and first blessing belong to [#722](https://github.com/odogono/odgn-talk/issues/722).
This draft must remain unmerged until Go and Zig consumers cover the shared
instruction declarations ([#720](https://github.com/odogono/odgn-talk/issues/720),
[#721](https://github.com/odogono/odgn-talk/issues/721)).

- Rename any Argument Label `otherwise` in declarations, event heads, calls,
  `pass` and target-first sends. Update dynamic Selector strings and Host
  message producers and consumers together. Old sends may silently select
  a different message: `move a otherwise b` now passes one default expression
  to `move`, rather than sending `move:otherwise:`.
- Group an index variable named `otherwise`: change `item otherwise of xs`
  to `item (otherwise) of xs`.
- Variables, functions, Handlers and map keys named `otherwise` remain legal.
  `the optional of m` still reads the ordinary key `optional`.

`a otherwise b` defaults only Nothing and evaluates `b` lazily. For every
nullable map step, write `the optional k of x`; no optional form reads Host
properties or writes a Container. `lookup` remains available for eager
fallbacks, list positions and whole-path validation. Existing save mismatch
handling applies; there is no automatic snapshot or Selector migration.
