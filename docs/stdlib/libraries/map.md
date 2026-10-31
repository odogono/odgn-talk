# map

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

The `map` Library is part of the Standard Library, so every Group holds it. A Script imports the names it uses, as in `use merge from map`. Its normative source is [`spec/stdlib/map.talk`](../../../spec/stdlib/map.talk), and the full rules are in [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#map).

An argument of the wrong kind raises `wrong kind` before any work is done, so the entries below list only the other errors each raises ([every stdlib function](../../../spec/07-libraries-and-the-standard-library.md#rules-for-every-stdlib-function)).

### merge

`merge(a, b)`

The map with the entries of `a` and then of `b`, where `b`'s value wins for a key in both.

### without

`without(m, keys)`

`m` without the entries whose keys are in the list `keys`.

### pick

`pick(m, keys)`

`m` with only the entries whose keys are in the list `keys`, in `m`'s order.

### entries

`entries(m)`

The list of pairs `[key, value]` of `m`, in order.

### fromEntries

`fromEntries(pairs)`

The map with the entries of the list of pairs `pairs`, where a later pair wins for a repeated key.

### mapValues

`mapValues(m, f)`

`m` with each value replaced by what `f` gives for it, keys and order kept.

### lookup

`lookup(m, path, default = nothing)`

The value the Value Path `path` locates inside `m`, or `default` if a key or position along it is missing or holds Nothing.

### withPath

`withPath(m, path, v)`

`m` with `v` at the Value Path `path`.

### withoutPath

`withoutPath(m, path)`

`m` with the key or item at the Value Path `path` removed.

### hasPath

`hasPath(m, path)`

Whether the Value Path `path` locates a value inside `m` that isn't Nothing.

### transform

`transform(value, mapping)`

A complete fresh mapped value, or ordered diagnostics without partial output.

Also raises: [`invalid mapping`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).
