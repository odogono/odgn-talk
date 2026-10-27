# `set` writes a path below a Host Object property as one crossing

A Host that keeps structured data, such as an Entity Component System, exposes it as map-valued properties, and changing one field meant `set the door of me to merge(the door of me, {isLocked: true})` ([#1626](https://github.com/odogono/odgn-talk/issues/1626)). `set` now also takes a Container path below a Host Object property, such as `set the isLocked of the door of me to true`. It reads the property with its `Get`, writes the path into that value by `put`'s rules, and writes the result with one `Set`, checked against the property's Shape. Value Semantics and the Host boundary are unchanged: this is shorthand for the `merge` form.

- **Path:** any Container path `put` accepts below the property, so keys at any depth, list items and chunks.
- **One crossing:** the `Get` and the `Set` are one Host Crossing for Stop, cancel and rewind. They land before the `Get` or after the `Set`, never between them, and a native Core does not act between them either.
- **Fuel and Trace:** charged and recorded as an ordinary `prop` get followed by a `prop` set. There is no new record kind.
- **Missing steps:** as `put`, a step through Nothing or a non-map raises `wrong kind` with `expected` `"map"` after the `Get` and before any `Set`. Only the last key can be added.
- **Load checks:** the read-only check stays on the property. Keys inside a property's Shape are not checked at load. The Shape check before the `Set` catches a bad value at run time.
- **`put` stays an error:** `put` into a Host Object key, and `add`, `subtract`, `multiply` and `divide`, which are defined as `put`, still raise `wrong kind`. So every write that reaches a Host is a visible `set`.

We made the pair one crossing because the author writes one statement. A Stop landing between the `Get` and the `Set` would drop a write that the Script reads as a single effect.

## Considered Options

- **Two independent crossings:** simpler for Cores, but a Stop could land between the read and the write.
- **Creating missing intermediate maps:** that would be a separate feature for both `put` and `set`.
- **Letting `put` write Host keys:** Host writes would then be hidden among ordinary value writes.
