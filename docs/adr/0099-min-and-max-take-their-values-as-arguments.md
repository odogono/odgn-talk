# `min` and `max` take their values as arguments

`min` and `max` take any number of values, `max(6, 3, 9)`, and one list argument still means its items, so `max([6, 3, 9])` gives the same `9` ([#1132](https://github.com/odogono/odgn-talk/issues/1132)). A single argument of another kind is the only value, so `max(7)` is `7`. We chose this because most calls compare a few known values, and `max(100, interval)` is what people write first. Making them wrap the values in a list was a load error a beginner had to decode, as it was while building the Tetris Example Project ([#1109](https://github.com/odogono/odgn-talk/issues/1109)). Keeping the list form means no Script has to change.

This makes `min` and `max` the first variadic Built-ins, so the rule is general. The catalogue writes a variadic Built-in with a trailing `…`, as `max(x, …)`. A call passes at least its named arguments, with no upper bound, and tooling, the Manifest and the Lints read the same notation. Only Built-ins are variadic. They aren't values, so no Function Value is variadic, and `functionArity` keeps its range. The Cost Model rates are unchanged: they count the values scanned, whether those are arguments or a list's items.

## Considered Options

- **Values only, with a spread at call sites,** `max(...xs)`: a cleaner rule, but spreads reach only a `send … with` list today, and extending them to every call is a larger language change than this needs. Every existing `max(xs)` would break.
- **Values only, with the list form moved to the `list` Library:** breaks every existing call, and gives two names for one idea.
- **Keeping the list form only:** the load error stays, and a hint in its message would still make the beginner rewrite the call.

## Consequences

- **`max(xs)` reads by kind:** with one argument, a list means its items, and anything else is the only value. Comparing two lists needs two arguments, `max(a, b)`.
- **`min()` is a load error,** `wrong argument count`, and `min([])` still raises `out of domain`.
- **Each Core's checker** treats a variadic Built-in's argument count as having no upper bound.
