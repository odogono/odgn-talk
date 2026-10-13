# Migrating to Nothing defaults (language 1.0-rc.3)

The TS implementation supports `a otherwise b` and `the optional k of x`.
Release activation and regenerated versions, Trace headers and Group
Fingerprints are coordinated by [#722](https://github.com/odogono/odgn-talk/issues/722).
Cost Model 0 remains provisional. This draft must not be released under the
old language revision; existing save mismatch handling applies.

- Rename every Argument Label `otherwise` in declarations, calls, `pass`,
  target-first sends and event heads. Update dynamic Selector strings and
  Host message producers and consumers together. An old command such as
  `choose x otherwise y` now calls `choose` with one default expression,
  rather than `choose:otherwise:` with two arguments; diagnostics alone
  cannot make this migration safe.
- Group an index variable named `otherwise`: write `item (otherwise) of xs`
  instead of `item otherwise of xs`.
- Variables, functions, Handlers and map keys named `otherwise` remain legal.
  `the optional of m` still reads the ordinary key `optional`.

Only Nothing triggers a fallback. Empty collections, empty text, zero and
false do not. Each optional step tolerates only maps and Nothing, rejects
Host Objects even for `id`, and is never writable. There is no `??` spelling.
`lookup` remains supported, with its eager default, list paths and path errors.

See [the language rules](../../spec/04-expressions-and-statements.md#nothing-defaults).
