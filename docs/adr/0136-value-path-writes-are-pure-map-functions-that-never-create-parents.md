# Value Path writes are pure `map` functions that never create parents

A Script that gets a Value Path as data, such as `["components", "door", "isLocked"]` from a message, could read through it with `lookup` but had to write its own recursion to change it ([#1631](https://github.com/odogono/odgn-talk/issues/1631)). The `map` Library now adds `withPath(m, path, v)`, `withoutPath(m, path)` and `hasPath(m, path)`. Each is pure, never calls the Host, and steps and validates the path as `lookup` does.

- **Names:** `without(m, keys)` already exists, so the path functions are named after the path, to pair with `lookup`.
- **Missing parents raise:** a step through a missing key, Nothing or a non-map raises `wrong kind` with `expected` `"map"` (or `"list"`) and `path`, as `put` and [ADR 0135](0135-set-writes-a-path-below-a-host-object-property-as-one-crossing.md)'s `set` do. Only the last step can be added.
- **Past a list's end:** `withPath` pads with Nothing, as `put … into item n` does.
- **`withoutPath`** removes as `delete` does: a list item is removed and the rest move up, and a key or position that isn't there leaves the value unchanged.
- **`hasPath`** is `lookup(m, path) is not nothing`, so a key that holds Nothing counts as missing.
- **JSON Pointer** text is converted to a Value Path by `json`'s `pointerPath(text)`, so the language keeps one path syntax.

We chose to raise rather than create parents because an integer step makes creation ambiguous: a list padded with Nothing, or a map. A Script can build a parent explicitly with `withPath(m, ["a"], {})`.

## Considered Options

- **Creating missing parents**, by default, by an option or by a second function, as elixir-jsonpointer does: rejected for the ambiguity above.
- **`update(m, path, f)`:** left out. `withPath(m, p, f(lookup(m, p)))` covers it, and it can be added later.
