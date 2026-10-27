# Property writes do not replace implicit bindings

`set` may write a whole Host Object property through `me`, `it` or `the target`, including keys and chunks that locate the receiving Object, while those implicit bindings remain nonassignable ([#744](https://github.com/odogono/odgn-talk/issues/744)). This lets a Script change itself, a newly returned Object or the original message Target without introducing ordinary value mutation through implicit bindings or property read/modify/write effects. It qualifies [ADR 0079](0079-built-in-properties-are-read-only-in-containers.md)'s variable-root requirement for `set` only; its prohibition on Built-in properties along the target path remains unchanged.

[ADR 0135](0135-set-writes-a-path-below-a-host-object-property-as-one-crossing.md) supersedes the exclusion of property read/modify/write: `set` may now write a path below a property. The implicit bindings stay nonassignable.
