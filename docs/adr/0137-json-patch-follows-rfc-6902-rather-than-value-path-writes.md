# JSON Patch follows RFC 6902 rather than Value Path writes

The `json` Library adds `applyPatch(doc, patch)`, which applies an RFC 6902 JSON Patch, given as a value such as `decodeJson` gives, and returns the patched value ([#1632](https://github.com/odogono/odgn-talk/issues/1632)). Inside a patch the RFC's rules win over [ADR 0136](0136-value-path-writes-are-pure-map-functions-that-never-create-parents.md)'s, because conforming to the RFC is the export's only purpose.

- **Pointers resolve against the value:** each reference token is read against what it reaches, so `"0"` is a key on a map and an index on a list, and `-` is past a list's end only for `add`. `pointerPath`, which can't see the value, isn't used.
- **RFC operations:** `add` inserts into a list and moves later items up, `remove` and `replace` raise when the target is missing, and a missing parent raises. `move`, `copy` and `test` follow the RFC. `test` compares with `=`, which ignores map order and compares numbers by value, as JSON equality does.
- **All or nothing:** a failing operation raises `can't patch` with `index` (its 1-based position), `op`, `path` and `reason`. Being pure, `applyPatch` never leaves a partly patched value.
- **In `json`:** the patch format is JSON's, and a new stdlib Library would change the fixed set of [ADR 0021](0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md).

## Considered Options

- **Building on `withPath` and `withoutPath` as they are:** rejected, since they replace rather than insert, ignore a missing target, and can't tell a digit key from an index.
- **Taking the patch as JSON text:** rejected; a Script decodes it first, as for any JSON.
