# list

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

The `list` Library is part of the Standard Library, so every Group holds it. A Script imports the names it uses, as in `use sum from list`. Its normative source is [`spec/stdlib/list.talk`](../../../spec/stdlib/list.talk), and the full rules are in [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#list).

An argument of the wrong kind raises `wrong kind` before any work is done, so the entries below list only the other errors each raises ([every stdlib function](../../../spec/07-libraries-and-the-standard-library.md#rules-for-every-stdlib-function)).

### sum

`sum(xs)`

The items of `xs` added with `+`, left to right, or 0 for an empty list.

Also raises: [`incompatible units`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### average

`average(xs)`

The sum of `xs` divided by its length.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`incompatible units`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### zip

`zip(xs, ys)`

The list of pairs `[x, y]` of items at the same position, as long as the shorter list.

### unique

`unique(xs)`

`xs` without the items equal to an earlier item.

### reverse

`reverse(xs)`

`xs` in reverse order.

### flatten

`flatten(xs)`

`xs` with each item that is a list replaced by its items, one level deep.

### sort

`sort(xs, direction = "ascending")`

`xs` sorted by `<`, stably.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`can't compare`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### sortBy

`sortBy(xs, key, direction = "ascending")`

`xs` sorted by `<` on the value `key` gives for each item, stably.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`can't compare`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### sortWith

`sortWith(xs, compare, direction = "ascending")`

`xs` sorted by the two-argument comparator `compare`, stably.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### filter

`filter(xs, keep)`

The items of `xs` for which `keep` gives true, in order.

### map

`map(xs, f)`

The list of what `f` gives for each item of `xs`, in order.

### reduce

`reduce(xs, f, initial)`

`f(f(f(initial, x1), x2), …)` over the items of `xs`, or `initial` for an empty list.

### group

`group(xs, key)`

A map from each text `key` gives to the list of items that gave it, keyed in first-seen order.

### partition

`partition(xs, keep)`

`[matching, rest]`: the items for which `keep` gives true and the others, each in order.

### any

`any(xs, test)`

Whether `test` gives true for some item, stopping at the first that does.

### all

`all(xs, test)`

Whether `test` gives true for every item, stopping at the first that doesn't.

### find

`find(xs, test)`

The first item for which `test` gives true, or Nothing.

### indexOf

`indexOf(xs, value)`

The position of the first item equal to `value`, or 0 if there is none.
