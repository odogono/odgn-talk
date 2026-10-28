# An Object Collection is walked as an eager snapshot list

This amends [ADR 0100](0100-object-element-references-use-a-fixed-spelling-and-a-host-collection.md),
which left enumeration and `whose` over elements out. For
[#1627](https://github.com/odogono/odgn-talk/issues/1627), `the elements of o`
is an ordinary list of the Host Objects in `o`'s Object Collection, in
collection order. `repeat for each` and Whose Clauses walk it by the existing
list rules, and `element` becomes an Every Head and ordinal Whose head, so
`every element of room whose …` and `the first element of room whose …` no
longer fail to parse.

The list is read eagerly, in one Host Crossing: `Count` once, then `At` for
each position, each charged at its declared cost before the callback, plus the
list's allocation. This makes "a snapshot taken when the walk starts" literally
true, keeps the contract's rule that membership is stable throughout one read,
and needs no new Host callback. `the first … whose` reads the whole collection
before testing, with no lazy early-stop path. A member disposed after the read
is still handed out, and raises `object gone` where it is used, as any stored
handle does.

The receiver checks are the count's, with `function` `"elements"`. An `At` that
gives Nothing below the count is `host error`. Like the other element forms it
is `not in a guard` and `not constant`.

## Considered options

- **Lazy walk** (`At` on each visit): avoids reading unvisited members for
  `the first … whose`, but the loop body can change membership between visits,
  so it is not a snapshot and indices can skip or repeat members.
- **A walk-only form** with no storable value: needs its own lowering in every
  Core and disagrees with every other `the Ks of x`.
- **Skipping disposed members**: needs a liveness check that list walks lack,
  and a stored list of handles would behave differently from the walk.
