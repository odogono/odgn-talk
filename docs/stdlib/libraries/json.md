# json

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

The `json` Library is part of the Standard Library, so every Group holds it. A Script imports the names it uses, as in `use decodeJson from json`. Its normative source is [`spec/stdlib/json.talk`](../../../spec/stdlib/json.talk), and the full rules are in [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#json).

An argument of the wrong kind raises `wrong kind` before any work is done, so the entries below list only the other errors each raises ([every stdlib function](../../../spec/07-libraries-and-the-standard-library.md#rules-for-every-stdlib-function)).

### decodeJson

`decodeJson(t)`

The value the JSON text `t` holds.

Also raises: [`can't decode`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### encodeJson

`encodeJson(v)`

The value `v` as compact JSON text.

Also raises: [`not encodable`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### pointerPath

`pointerPath(t)`

The Value Path the JSON Pointer text `t` locates, with each array index as a 1-based position.

### applyPatch

`applyPatch(doc, patch)`

`doc` with the RFC 6902 JSON Patch `patch`, a list of operations, applied in order.

Also raises: [`can't patch`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).
